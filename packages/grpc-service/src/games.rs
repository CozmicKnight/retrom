use diesel::{ExpressionMethods, QueryDsl, SelectableHelper};
use diesel_async::RunQueryDsl;
use futures::future::join_all;
use regex::Regex;
use retrom_codegen::retrom::{
    self, game_service_server::GameService, ContentDirectory, DeleteGamesRequest,
    DeleteGamesResponse, Game, GameFile, GameMetadata, GetGamesRequest, GetGamesResponse,
    StorageType,
};
use retrom_db::{schema, Pool};
use retrom_service_common::{
    config::resolve_metadata_path, media_cache::cacheable_media::CacheableMetadata,
};
use std::{collections::HashMap, path::Path, path::PathBuf, sync::Arc};
use tonic::{Code, Request, Response, Status};

#[derive(Clone)]
pub struct GameServiceHandlers {
    pub db_pool: Arc<Pool>,
    pub config_manager: Arc<retrom_service_common::config::ServerConfigManager>,
}

impl GameServiceHandlers {
    pub fn new(
        db_pool: Arc<Pool>,
        config_manager: Arc<retrom_service_common::config::ServerConfigManager>,
    ) -> Self {
        Self {
            db_pool,
            config_manager,
        }
    }
}

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
struct CanonicalGroupKey {
    platform_id: Option<i32>,
    igdb_id: i64,
}

#[derive(Debug, Clone)]
struct ConfiguredContentDirectory {
    root: PathBuf,
    smart_structure_enabled: bool,
    depth: usize,
}

fn ext_score(path: &str) -> i32 {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "cue" => 100,
        "m3u" => 90,
        "chd" => 80,
        "iso" => 70,
        "ccd" => 60,
        "img" => 55,
        "bin" => 10,
        _ => 20,
    }
}

fn normalized_tokens(input: &str) -> Vec<String> {
    let token_re = Regex::new(r"[a-z0-9]+").expect("valid token regex");
    token_re
        .find_iter(&input.to_ascii_lowercase())
        .map(|m| m.as_str().to_string())
        .filter(|t| t.len() > 1)
        .collect()
}

fn path_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn disc_number(path: &str) -> Option<u32> {
    let disc_re = Regex::new(r"(?i)(disc|disk|cd)\s*([0-9]{1,2})").expect("valid disc regex");
    disc_re
        .captures(path)
        .and_then(|c| c.get(2))
        .and_then(|m| m.as_str().parse::<u32>().ok())
}

fn region_tag(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    [
        "usa", "europe", "japan", "world", "pal", "ntsc", "ntsc-u", "ntsc-j",
    ]
    .iter()
    .find(|candidate| lower.contains(**candidate))
    .map(|s| s.to_string())
}

fn file_confident_for_metadata(path: &str, metadata_name: &str) -> bool {
    let name_tokens = normalized_tokens(metadata_name);
    if name_tokens.is_empty() {
        return false;
    }

    let file_tokens = normalized_tokens(&path_stem(path));
    if file_tokens.is_empty() {
        return false;
    }

    let overlap = name_tokens
        .iter()
        .filter(|token| file_tokens.iter().any(|t| t == *token))
        .count();

    overlap >= 2 || (overlap >= 1 && name_tokens.len() <= 2)
}

fn choose_primary_game(games: &[Game], files: &[GameFile]) -> i32 {
    games
        .iter()
        .map(|game| {
            let default_file_score = game
                .default_file_id
                .and_then(|id| files.iter().find(|f| f.id == id))
                .map(|f| ext_score(&f.path))
                .unwrap_or(0);

            let best_member_file_score = files
                .iter()
                .filter(|f| f.game_id == game.id)
                .map(|f| ext_score(&f.path))
                .max()
                .unwrap_or_else(|| ext_score(&game.path));

            (
                game.id,
                std::cmp::max(default_file_score, best_member_file_score),
            )
        })
        .max_by_key(|(_, score)| *score)
        .map(|(id, _)| id)
        .unwrap_or(games[0].id)
}

fn should_group_candidates(games: &[Game], files: &[GameFile], metadata_name: &str) -> bool {
    if games.len() < 2 {
        return false;
    }

    // Confidence gate: each source game must have at least one matching path stem.
    for game in games {
        let has_confident_match = files
            .iter()
            .filter(|f| f.game_id == game.id)
            .map(|f| f.path.as_str())
            .chain(std::iter::once(game.path.as_str()))
            .any(|path| file_confident_for_metadata(path, metadata_name));

        if !has_confident_match {
            return false;
        }
    }

    // Avoid grouping regional variants as a single title.
    let regions = games
        .iter()
        .filter_map(|g| region_tag(&g.path))
        .collect::<std::collections::HashSet<_>>();

    if regions.len() > 1 {
        return false;
    }

    true
}

fn apply_smart_structure(
    games: Vec<Game>,
    metadata: Vec<GameMetadata>,
    game_files: Vec<GameFile>,
) -> (Vec<Game>, Vec<GameMetadata>, Vec<GameFile>) {
    let mut grouped_games = games.clone();
    let mut grouped_meta = metadata.clone();
    let mut grouped_files = game_files.clone();

    let metadata_by_game_id: HashMap<i32, GameMetadata> =
        metadata.into_iter().map(|m| (m.game_id, m)).collect();
    let games_by_id: HashMap<i32, Game> = games.into_iter().map(|g| (g.id, g)).collect();

    let mut candidates: HashMap<CanonicalGroupKey, Vec<Game>> = HashMap::new();
    for game in games_by_id.values() {
        let Some(meta) = metadata_by_game_id.get(&game.id) else {
            continue;
        };

        let Some(igdb_id) = meta.igdb_id else {
            continue;
        };

        let key = CanonicalGroupKey {
            platform_id: game.platform_id,
            igdb_id,
        };
        candidates.entry(key).or_default().push(game.clone());
    }

    let mut alias_to_primary: HashMap<i32, i32> = HashMap::new();
    for members in candidates.values() {
        if members.len() < 2 {
            continue;
        }

        let Some(metadata_name) = members
            .iter()
            .find_map(|g| metadata_by_game_id.get(&g.id))
            .and_then(|m| m.name.clone())
        else {
            continue;
        };

        if !should_group_candidates(members, &grouped_files, &metadata_name) {
            continue;
        }

        let primary_game_id = choose_primary_game(members, &grouped_files);
        let mut seen_discs = std::collections::HashSet::new();
        for member in members {
            if member.id == primary_game_id {
                continue;
            }

            // If both members are explicitly disc-numbered and collide on disc number,
            // keep them separate to avoid accidental merges.
            let member_disc = disc_number(&member.path);
            if let Some(member_disc) = member_disc {
                if !seen_discs.insert(member_disc) {
                    continue;
                }
            }

            alias_to_primary.insert(member.id, primary_game_id);
        }
    }

    if alias_to_primary.is_empty() {
        return (grouped_games, grouped_meta, grouped_files);
    }

    grouped_games.retain(|g| !alias_to_primary.contains_key(&g.id));
    grouped_meta.retain(|m| !alias_to_primary.contains_key(&m.game_id));

    for file in &mut grouped_files {
        if let Some(primary_id) = alias_to_primary.get(&file.game_id) {
            file.game_id = *primary_id;
        }
    }

    tracing::info!(
        grouped_games = alias_to_primary.len(),
        "Smart Structure grouped filesystem-driven game records"
    );

    (grouped_games, grouped_meta, grouped_files)
}

fn normalize_content_dir_path(path: &str) -> PathBuf {
    PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
}

fn configured_content_directories(
    content_directories: &[ContentDirectory],
) -> Vec<ConfiguredContentDirectory> {
    content_directories
        .iter()
        .map(|content_directory| {
            let root = normalize_content_dir_path(&content_directory.path);
            let depth = root.components().count();

            ConfiguredContentDirectory {
                root,
                smart_structure_enabled: content_directory.smart_structure_enabled,
                depth,
            }
        })
        .collect()
}

fn path_matches_content_dir(path: &str, root: &Path) -> bool {
    let raw_path = Path::new(path);
    if raw_path.starts_with(root) {
        return true;
    }

    normalize_content_dir_path(path).starts_with(root)
}

fn matching_content_dir_index(
    path: &str,
    configured_dirs: &[ConfiguredContentDirectory],
) -> Option<usize> {
    configured_dirs
        .iter()
        .enumerate()
        .filter(|(_, content_dir)| path_matches_content_dir(path, &content_dir.root))
        .max_by_key(|(_, content_dir)| content_dir.depth)
        .map(|(index, _)| index)
}

fn apply_smart_structure_by_content_dir(
    content_directories: &[ContentDirectory],
    games: Vec<Game>,
    metadata: Vec<GameMetadata>,
    game_files: Vec<GameFile>,
) -> (Vec<Game>, Vec<GameMetadata>, Vec<GameFile>) {
    let configured_dirs = configured_content_directories(content_directories);
    if configured_dirs.iter().all(|content_dir| !content_dir.smart_structure_enabled) {
        return (games, metadata, game_files);
    }

    let mut smart_game_buckets: HashMap<usize, Vec<Game>> = HashMap::new();
    let mut passthrough_games = Vec::new();
    let mut smart_bucket_by_game_id: HashMap<i32, usize> = HashMap::new();

    for game in games {
        match matching_content_dir_index(&game.path, &configured_dirs) {
            Some(index) if configured_dirs[index].smart_structure_enabled => {
                smart_bucket_by_game_id.insert(game.id, index);
                smart_game_buckets.entry(index).or_default().push(game);
            }
            _ => passthrough_games.push(game),
        }
    }

    if smart_game_buckets.is_empty() {
        return (passthrough_games, metadata, game_files);
    }

    let mut smart_metadata_buckets: HashMap<usize, Vec<GameMetadata>> = HashMap::new();
    let mut passthrough_metadata = Vec::new();
    for metadata_row in metadata {
        match smart_bucket_by_game_id.get(&metadata_row.game_id).copied() {
            Some(index) => smart_metadata_buckets
                .entry(index)
                .or_default()
                .push(metadata_row),
            None => passthrough_metadata.push(metadata_row),
        }
    }

    let mut smart_file_buckets: HashMap<usize, Vec<GameFile>> = HashMap::new();
    let mut passthrough_files = Vec::new();
    for game_file in game_files {
        match smart_bucket_by_game_id.get(&game_file.game_id).copied() {
            Some(index) => smart_file_buckets.entry(index).or_default().push(game_file),
            None => passthrough_files.push(game_file),
        }
    }

    let mut grouped_games = Vec::new();
    let mut grouped_metadata = Vec::new();
    let mut grouped_files = Vec::new();

    let mut indexes = smart_game_buckets.keys().copied().collect::<Vec<_>>();
    indexes.sort_unstable();

    for index in indexes {
        let smart_games = smart_game_buckets.remove(&index).unwrap_or_default();
        let smart_metadata = smart_metadata_buckets.remove(&index).unwrap_or_default();
        let smart_files = smart_file_buckets.remove(&index).unwrap_or_default();

        let (next_games, next_metadata, next_files) =
            apply_smart_structure(smart_games, smart_metadata, smart_files);

        grouped_games.extend(next_games);
        grouped_metadata.extend(next_metadata);
        grouped_files.extend(next_files);
    }

    grouped_games.extend(passthrough_games);
    grouped_metadata.extend(passthrough_metadata);
    grouped_files.extend(passthrough_files);

    (grouped_games, grouped_metadata, grouped_files)
}

#[tonic::async_trait]
impl GameService for GameServiceHandlers {
    async fn get_games(
        &self,
        request: Request<GetGamesRequest>,
    ) -> Result<Response<GetGamesResponse>, Status> {
        let request = request.into_inner();
        let include_deleted = request.include_deleted();

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let mut query = schema::games::table
            .into_boxed()
            .select(retrom::Game::as_select());

        if !&request.ids.is_empty() {
            query = query.filter(schema::games::id.eq_any(&request.ids));
        }

        if !include_deleted {
            query = query.filter(schema::games::is_deleted.eq(false));
        }

        if !&request.platform_ids.is_empty() {
            query = query.filter(schema::games::platform_id.eq_any(&request.platform_ids));
        }

        let games_data: Vec<retrom::Game> = match query.load(&mut conn).await {
            Ok(rows) => rows,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let mut metadata_data: Vec<retrom::GameMetadata> = vec![];
        let mut game_files_data: Vec<retrom::GameFile> = vec![];

        let game_ids: Vec<i32> = games_data.iter().map(|game| game.id).collect();

        if request.with_metadata() {
            let metadata_rows = schema::game_metadata::table
                .filter(schema::game_metadata::game_id.eq_any(&game_ids))
                .load::<retrom::GameMetadata>(&mut conn)
                .await;

            match metadata_rows {
                Ok(rows) => metadata_data.extend(rows),
                Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
            };
        }

        if request.with_files() {
            let mut query = schema::game_files::table
                .into_boxed()
                .filter(schema::game_files::game_id.eq_any(&game_ids));

            if !include_deleted {
                query = query.filter(schema::game_files::is_deleted.eq(false));
            }

            let game_files_rows = query.load::<retrom::GameFile>(&mut conn).await;

            match game_files_rows {
                Ok(rows) => game_files_data.extend(rows),
                Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
            };
        }

        let config = self.config_manager.get_config().await;
        let smart_structure_enabled = config
            .metadata
            .as_ref()
            .map(|m| m.smart_structure_enabled)
            .unwrap_or(false);

        let (games_data, metadata_data, game_files_data) = if smart_structure_enabled {
            apply_smart_structure_by_content_dir(
                &config.content_directories,
                games_data,
                metadata_data,
                game_files_data,
            )
        } else {
            (games_data, metadata_data, game_files_data)
        };

        let response = GetGamesResponse {
            games: games_data,
            metadata: metadata_data,
            game_files: game_files_data,
        };

        Ok(Response::new(response))
    }

    async fn delete_games(
        &self,
        request: Request<DeleteGamesRequest>,
    ) -> Result<Response<DeleteGamesResponse>, Status> {
        let request = request.into_inner();
        let delete_from_disk = request.delete_from_disk;
        let blacklist_entries = request.blacklist_entries;

        {
            let mut conn = match self.db_pool.get().await {
                Ok(conn) => conn,
                Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
            };
            let config = self.config_manager.get_config().await;
            let metadata_dir = resolve_metadata_path(config.metadata.as_ref());

            let metadata: Vec<GameMetadata> = schema::game_metadata::table
                .filter(schema::game_metadata::game_id.eq_any(&request.ids))
                .load(&mut conn)
                .await
                .unwrap_or_default();

            drop(conn);

            join_all(metadata.iter().map(|m| m.clean_cache(&metadata_dir))).await;
        }

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let games_deleted: Vec<Game> = match blacklist_entries {
            true => {
                diesel::update(
                    schema::game_files::table
                        .filter(schema::game_files::game_id.eq_any(&request.ids)),
                )
                .set((
                    schema::game_files::is_deleted.eq(true),
                    schema::game_files::deleted_at.eq(diesel::dsl::now),
                ))
                .execute(&mut conn)
                .await
                .map_err(|why| Status::new(Code::Internal, why.to_string()))?;

                diesel::update(schema::games::table.filter(schema::games::id.eq_any(&request.ids)))
                    .set((
                        schema::games::is_deleted.eq(true),
                        schema::games::deleted_at.eq(diesel::dsl::now),
                    ))
                    .get_results(&mut conn)
                    .await
                    .map_err(|why| Status::new(Code::Internal, why.to_string()))?
            }
            false => {
                diesel::delete(schema::games::table.filter(schema::games::id.eq_any(&request.ids)))
                    .get_results(&mut conn)
                    .await
                    .map_err(|why| Status::new(Code::Internal, why.to_string()))?
            }
        };

        if delete_from_disk {
            let delete_tasks: Vec<_> = games_deleted
                .iter()
                .map(|game| {
                    let path = PathBuf::from(&game.path);
                    let game_id = game.id;

                    async move {
                        if path.exists() {
                            let result = if path.is_dir() {
                                tokio::fs::remove_dir_all(&path).await
                            } else {
                                tokio::fs::remove_file(&path).await
                            };

                            if let Err(why) = result {
                                tracing::error!(
                                    "Failed to delete game {} from disk: {}",
                                    game_id,
                                    why
                                );
                            }
                        }
                    }
                })
                .collect();

            futures::future::join_all(delete_tasks).await;
        }

        let response = DeleteGamesResponse { games_deleted };

        Ok(Response::new(response))
    }

    async fn update_games(
        &self,
        request: Request<retrom::UpdateGamesRequest>,
    ) -> Result<Response<retrom::UpdateGamesResponse>, Status> {
        let request = request.into_inner();

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let to_update = request.games;
        let mut games_updated = Vec::new();

        for mut game in to_update {
            let id = game.id;

            if let Some(ref updated_path) = game.path {
                let current_game: Result<Game, _> =
                    schema::games::table.find(id).first(&mut conn).await;

                if let Ok(current_game) = current_game {
                    let old_game_path = PathBuf::from(&current_game.path);
                    let mut new_game_path = PathBuf::from(updated_path);
                    let sanitized_fname = new_game_path
                        .file_name()
                        .and_then(|os_str| os_str.to_str())
                        .map(sanitize_filename::sanitize);

                    if let Some(sanitized_fname) = sanitized_fname {
                        new_game_path.set_file_name(&sanitized_fname);
                        game.path = Some(new_game_path.to_str().unwrap().to_string());
                    }

                    let is_rename = old_game_path.file_name() != new_game_path.file_name();
                    let can_rename = old_game_path.exists() && !new_game_path.exists();
                    let paths_safe = old_game_path.parent() == new_game_path.parent();

                    if is_rename && can_rename && paths_safe {
                        if let Err(why) = tokio::fs::rename(&old_game_path, &new_game_path).await {
                            tracing::error!("Failed to rename file: {}", why);

                            continue;
                        }

                        let game_files = schema::game_files::table
                            .filter(schema::game_files::game_id.eq(id))
                            .load::<GameFile>(&mut conn)
                            .await
                            .map_err(|why| Status::new(Code::Internal, why.to_string()))?;

                        let storage_type = StorageType::try_from(current_game.storage_type).ok();

                        for game_file in game_files {
                            let old_file_path = PathBuf::from(game_file.path);
                            let new_file_path = match storage_type {
                                Some(StorageType::SingleFileGame) => new_game_path.clone(),
                                Some(StorageType::MultiFileGame) => new_game_path
                                    .join(old_file_path.strip_prefix(&old_game_path).unwrap()),
                                _ => {
                                    tracing::error!(
                                        "Invalid Storage type found for game {}",
                                        game.id
                                    );

                                    break;
                                }
                            };

                            if !new_file_path.exists() {
                                tracing::error!(
                                    "File does not exist, did game rename fail? - {:?}",
                                    new_file_path
                                );
                            }

                            let path = new_file_path
                                .canonicalize()
                                .ok()
                                .and_then(|p| p.to_str().map(|p| p.to_string()))
                                .unwrap();

                            diesel::update(
                                schema::game_files::table
                                    .filter(schema::game_files::id.eq(game_file.id)),
                            )
                            .set(schema::game_files::path.eq(path))
                            .execute(&mut conn)
                            .await
                            .map_err(|why| Status::new(Code::Internal, why.to_string()))?;
                        }
                    } else {
                        tracing::info!("Skipping game dir rename for game {}", game.id);

                        continue;
                    }
                }
            }

            let updated_game =
                diesel::update(schema::games::table.filter(schema::games::id.eq(id)))
                    .set(game)
                    .get_result(&mut conn)
                    .await
                    .map_err(|why| Status::new(Code::Internal, why.to_string()))?;

            games_updated.push(updated_game);
        }

        let response = retrom::UpdateGamesResponse { games_updated };

        Ok(Response::new(response))
    }

    async fn get_game_files(
        &self,
        request: Request<retrom::GetGameFilesRequest>,
    ) -> Result<Response<retrom::GetGameFilesResponse>, Status> {
        let request = request.into_inner();
        let include_deleted = request.include_deleted();

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let mut query = schema::game_files::table
            .into_boxed()
            .select(retrom::GameFile::as_select());

        if !&request.ids.is_empty() {
            query = query.filter(schema::game_files::id.eq_any(&request.ids));
        }

        if !&request.game_ids.is_empty() {
            query = query.filter(schema::game_files::game_id.eq_any(&request.game_ids));
        }

        if !include_deleted {
            query = query.filter(schema::game_files::is_deleted.eq(false));
        }

        let game_files_data: Vec<retrom::GameFile> = match query.load(&mut conn).await {
            Ok(rows) => rows,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let response = retrom::GetGameFilesResponse {
            game_files: game_files_data,
        };

        Ok(Response::new(response))
    }

    async fn delete_game_files(
        &self,
        request: Request<retrom::DeleteGameFilesRequest>,
    ) -> Result<Response<retrom::DeleteGameFilesResponse>, Status> {
        let request = request.into_inner();
        let delete_from_disk = request.delete_from_disk;
        let blacklist_entries = request.blacklist_entries;

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let game_files_deleted: Vec<GameFile> = match blacklist_entries {
            true => diesel::update(schema::game_files::table)
                .filter(schema::game_files::id.eq_any(&request.ids))
                .set((
                    schema::game_files::is_deleted.eq(true),
                    schema::game_files::deleted_at.eq(diesel::dsl::now),
                ))
                .get_results(&mut conn)
                .await
                .map_err(|why| Status::new(Code::Internal, why.to_string()))?,
            false => diesel::delete(
                schema::game_files::table.filter(schema::game_files::id.eq_any(&request.ids)),
            )
            .get_results(&mut conn)
            .await
            .map_err(|why| Status::new(Code::Internal, why.to_string()))?,
        };

        if delete_from_disk {
            let delete_tasks: Vec<_> = game_files_deleted
                .iter()
                .map(|game_file| {
                    let path = PathBuf::from(&game_file.path);
                    let file_id = game_file.id;

                    async move {
                        if path.exists() {
                            let result = if path.is_dir() {
                                tokio::fs::remove_dir_all(&path).await
                            } else {
                                tokio::fs::remove_file(&path).await
                            };

                            if let Err(why) = result {
                                let error_msg = if path.is_dir() {
                                    format!(
                                        "Failed to delete game sub-directory {} from disk: {}",
                                        file_id, why
                                    )
                                } else {
                                    format!(
                                        "Failed to delete game file {} from disk: {}",
                                        file_id, why
                                    )
                                };
                                tracing::error!("{}", error_msg);
                            }
                        }
                    }
                })
                .collect();

            futures::future::join_all(delete_tasks).await;
        }

        let response = retrom::DeleteGameFilesResponse { game_files_deleted };

        Ok(Response::new(response))
    }

    async fn update_game_files(
        &self,
        request: Request<retrom::UpdateGameFilesRequest>,
    ) -> Result<Response<retrom::UpdateGameFilesResponse>, Status> {
        let request = request.into_inner();

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => return Err(Status::new(Code::Internal, why.to_string())),
        };

        let to_update = request.game_files;
        let mut game_files_updated = Vec::new();

        for mut game_file in to_update {
            let id = game_file.id;

            if let Some(ref updated_path) = game_file.path {
                let current_file: Result<GameFile, _> =
                    schema::game_files::table.find(id).first(&mut conn).await;

                let mut new_file_path = PathBuf::from(updated_path);
                let sanitized_fname = new_file_path
                    .file_name()
                    .and_then(|os_str| os_str.to_str())
                    .map(sanitize_filename::sanitize);

                if let Some(sanitized_fname) = sanitized_fname {
                    new_file_path.set_file_name(&sanitized_fname);
                    game_file.path = Some(new_file_path.to_str().unwrap().to_string());
                }

                if let Ok(current_file) = current_file {
                    let old_path = PathBuf::from(&current_file.path);

                    let is_rename = old_path.file_name() != new_file_path.file_name();
                    let can_rename = old_path.exists() && !new_file_path.exists();
                    let paths_safe = old_path.parent() == new_file_path.parent();

                    if is_rename && can_rename && paths_safe {
                        if let Err(why) = tokio::fs::rename(&old_path, &new_file_path).await {
                            tracing::error!("Failed to rename file: {}", why);

                            continue;
                        }
                    } else {
                        tracing::error!("Failed to rename file: {:?}: path error", game_file.id);

                        continue;
                    }
                }
            }

            let updated_game_file: GameFile =
                diesel::update(schema::game_files::table.filter(schema::game_files::id.eq(id)))
                    .set(game_file)
                    .get_result(&mut conn)
                    .await
                    .map_err(|why| Status::new(Code::Internal, why.to_string()))?;

            let game_id = updated_game_file.game_id;

            let game: Game = schema::games::table
                .find(&game_id)
                .first(&mut conn)
                .await
                .expect("Could not find game entry for game file");

            if let Ok(StorageType::SingleFileGame) = StorageType::try_from(game.storage_type) {
                diesel::update(&game)
                    .set(schema::games::path.eq(&updated_game_file.path))
                    .execute(&mut conn)
                    .await
                    .expect("Could not update game path");
            }

            game_files_updated.push(updated_game_file);
        }

        let response = retrom::UpdateGameFilesResponse { game_files_updated };

        Ok(Response::new(response))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: i32, platform_id: i32, path: &str) -> Game {
        Game {
            id,
            platform_id: Some(platform_id),
            path: path.to_string(),
            ..Default::default()
        }
    }

    fn meta(game_id: i32, igdb_id: i64, name: &str) -> GameMetadata {
        GameMetadata {
            game_id,
            igdb_id: Some(igdb_id),
            name: Some(name.to_string()),
            ..Default::default()
        }
    }

    fn file(id: i32, game_id: i32, path: &str) -> GameFile {
        GameFile {
            id,
            game_id,
            path: path.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn smart_structure_groups_flat_cue_bin_sets() {
        let games = vec![
            game(1, 10, "/roms/ps1/Metal Gear Solid (Disc 1).cue"),
            game(2, 10, "/roms/ps1/Metal Gear Solid (Disc 2).cue"),
        ];
        let metadata = vec![
            meta(1, 101, "Metal Gear Solid"),
            meta(2, 101, "Metal Gear Solid"),
        ];
        let files = vec![
            file(11, 1, "/roms/ps1/Metal Gear Solid (Disc 1).cue"),
            file(12, 1, "/roms/ps1/Metal Gear Solid (Disc 1).bin"),
            file(13, 2, "/roms/ps1/Metal Gear Solid (Disc 2).cue"),
            file(14, 2, "/roms/ps1/Metal Gear Solid (Disc 2).bin"),
        ];

        let (games_out, _meta_out, files_out) = apply_smart_structure(games, metadata, files);
        assert_eq!(games_out.len(), 1);

        let grouped_id = games_out[0].id;
        assert!(files_out.iter().all(|f| f.game_id == grouped_id));
        assert!(files_out.iter().any(|f| f.path.ends_with(".cue")));
    }

    #[test]
    fn smart_structure_keeps_regional_variants_separate() {
        let games = vec![
            game(1, 10, "/roms/ps1/Crash Bandicoot (USA).cue"),
            game(2, 10, "/roms/ps1/Crash Bandicoot (Europe).cue"),
        ];
        let metadata = vec![
            meta(1, 200, "Crash Bandicoot"),
            meta(2, 200, "Crash Bandicoot"),
        ];
        let files = vec![
            file(21, 1, "/roms/ps1/Crash Bandicoot (USA).cue"),
            file(22, 2, "/roms/ps1/Crash Bandicoot (Europe).cue"),
        ];

        let (games_out, _meta_out, files_out) = apply_smart_structure(games, metadata, files);
        assert_eq!(games_out.len(), 2);
        assert_eq!(
            files_out.iter().map(|f| f.game_id).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn smart_structure_skips_low_confidence_matches() {
        let games = vec![
            game(1, 10, "/roms/ps1/random_file_a.cue"),
            game(2, 10, "/roms/ps1/random_file_b.cue"),
        ];
        let metadata = vec![
            meta(1, 300, "Final Fantasy VII"),
            meta(2, 300, "Final Fantasy VII"),
        ];
        let files = vec![
            file(31, 1, "/roms/ps1/random_file_a.cue"),
            file(32, 2, "/roms/ps1/random_file_b.cue"),
        ];

        let (games_out, _meta_out, files_out) = apply_smart_structure(games, metadata, files);
        assert_eq!(games_out.len(), 2);
        assert_eq!(
            files_out.iter().map(|f| f.game_id).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn choose_primary_prefers_cue_over_bin() {
        let games = vec![
            game(1, 10, "/roms/ps1/Game.bin"),
            game(2, 10, "/roms/ps1/Game.cue"),
        ];
        let files = vec![
            file(41, 1, "/roms/ps1/Game.bin"),
            file(42, 2, "/roms/ps1/Game.cue"),
        ];

        let primary = choose_primary_game(&games, &files);
        assert_eq!(primary, 2);
    }

    #[test]
    fn smart_structure_only_groups_smart_enabled_content_dirs() {
        let games = vec![
            game(1, 10, "/smart/ps1/Metal Gear Solid (Disc 1).cue"),
            game(2, 10, "/smart/ps1/Metal Gear Solid (Disc 2).cue"),
            game(3, 10, "/plain/ps1/Metal Gear Solid (Disc 1).cue"),
            game(4, 10, "/plain/ps1/Metal Gear Solid (Disc 2).cue"),
        ];
        let metadata = vec![
            meta(1, 101, "Metal Gear Solid"),
            meta(2, 101, "Metal Gear Solid"),
            meta(3, 101, "Metal Gear Solid"),
            meta(4, 101, "Metal Gear Solid"),
        ];
        let files = vec![
            file(11, 1, "/smart/ps1/Metal Gear Solid (Disc 1).cue"),
            file(12, 2, "/smart/ps1/Metal Gear Solid (Disc 2).cue"),
            file(13, 3, "/plain/ps1/Metal Gear Solid (Disc 1).cue"),
            file(14, 4, "/plain/ps1/Metal Gear Solid (Disc 2).cue"),
        ];

        let content_dirs = vec![
            ContentDirectory {
                path: "/smart".to_string(),
                smart_structure_enabled: true,
                ..Default::default()
            },
            ContentDirectory {
                path: "/plain".to_string(),
                smart_structure_enabled: false,
                ..Default::default()
            },
        ];

        let (games_out, _meta_out, files_out) =
            apply_smart_structure_by_content_dir(&content_dirs, games, metadata, files);

        assert_eq!(games_out.len(), 3);
        assert_eq!(
            files_out.iter().filter(|file| file.path.starts_with("/plain")).count(),
            2
        );
    }

    #[test]
    fn smart_structure_does_not_cross_group_between_smart_content_dirs() {
        let games = vec![
            game(1, 10, "/smart-a/ps1/Metal Gear Solid (Disc 1).cue"),
            game(2, 10, "/smart-a/ps1/Metal Gear Solid (Disc 2).cue"),
            game(3, 10, "/smart-b/ps1/Metal Gear Solid (Disc 1).cue"),
            game(4, 10, "/smart-b/ps1/Metal Gear Solid (Disc 2).cue"),
        ];
        let metadata = vec![
            meta(1, 101, "Metal Gear Solid"),
            meta(2, 101, "Metal Gear Solid"),
            meta(3, 101, "Metal Gear Solid"),
            meta(4, 101, "Metal Gear Solid"),
        ];
        let files = vec![
            file(11, 1, "/smart-a/ps1/Metal Gear Solid (Disc 1).cue"),
            file(12, 2, "/smart-a/ps1/Metal Gear Solid (Disc 2).cue"),
            file(13, 3, "/smart-b/ps1/Metal Gear Solid (Disc 1).cue"),
            file(14, 4, "/smart-b/ps1/Metal Gear Solid (Disc 2).cue"),
        ];

        let content_dirs = vec![
            ContentDirectory {
                path: "/smart-a".to_string(),
                smart_structure_enabled: true,
                ..Default::default()
            },
            ContentDirectory {
                path: "/smart-b".to_string(),
                smart_structure_enabled: true,
                ..Default::default()
            },
        ];

        let (games_out, _meta_out, files_out) =
            apply_smart_structure_by_content_dir(&content_dirs, games, metadata, files);

        assert_eq!(games_out.len(), 2);
        assert!(files_out.iter().any(|file| file.path.starts_with("/smart-a")));
        assert!(files_out.iter().any(|file| file.path.starts_with("/smart-b")));
    }
}
