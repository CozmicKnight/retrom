use crate::jobs::job_manager::JobError;
use bigdecimal::ToPrimitive;
use diesel::{ExpressionMethods, QueryDsl};
use diesel_async::RunQueryDsl;
use retrom_codegen::retrom::{NewGame, StorageType, UpdateLibraryRequest, UpdateLibraryResponse};
use retrom_db::schema::{self};
use tonic::{Request, Status};
use tracing::warn;

use super::{
    content_resolver::{game_resolver::ResolvedGame, ContentResolver},
    LibraryServiceHandlers,
};

async fn run_bounded<I, F, T>(work: I, max_in_flight: usize) -> Vec<T>
where
    I: IntoIterator<Item = F>,
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let mut join_set = tokio::task::JoinSet::new();
    let max_in_flight = std::cmp::max(max_in_flight, 1);
    let mut iter = work.into_iter();
    let mut results = Vec::new();

    for _ in 0..max_in_flight {
        if let Some(fut) = iter.next() {
            join_set.spawn(fut);
        }
    }

    while let Some(res) = join_set.join_next().await {
        if let Some(next) = iter.next() {
            join_set.spawn(next);
        }

        match res {
            Ok(output) => results.push(output),
            Err(why) => warn!("Bounded task join failed: {why:#?}"),
        }
    }

    results
}

pub(super) async fn update_library(
    state: &LibraryServiceHandlers,
    _request: Request<UpdateLibraryRequest>,
) -> Result<UpdateLibraryResponse, Status> {
    let content_dirs = state.config_manager.get_config().await.content_directories;

    let db_pool = state.db_pool.clone();

    let error_logger = |why| {
        tracing::warn!("Failed to resolve content: {}", why);
        None::<ContentResolver>
    };

    let tasks: Vec<_> = content_dirs
        .into_iter()
        .map(ContentResolver::from_content_dir)
        .filter_map(|resolver| resolver.map_err(error_logger).ok())
        .flat_map(|content_dir| {
            let db_pool = db_pool.clone();

            let platform_resolvers = match content_dir.resolve_platforms() {
                Ok(platform_resolvers) => platform_resolvers,
                Err(why) => {
                    warn!("Failed to resolve platforms: {}", why);
                    Vec::new()
                }
            };

            platform_resolvers
                .into_iter()
                .map(move |platform_resolver| {
                    let db_pool = db_pool.clone();

                    async move {
                        let resolved_platform =
                            match platform_resolver.resolve(db_pool.clone()).await {
                                Ok(platform) => platform,
                                Err(why) => {
                                    return Err(why.to_string());
                                }
                            };

                        let game_resolvers = match resolved_platform.get_game_resolvers() {
                            Ok(game_resolvers) => game_resolvers,
                            Err(why) => {
                                return Err(why.to_string());
                            }
                        };

                        let scan_concurrency = std::env::var("RETROM_SCAN_CONCURRENCY")
                            .ok()
                            .and_then(|v| v.parse::<usize>().ok())
                            .filter(|v| *v > 0)
                            .unwrap_or(16);

                        tracing::info!(
                            scan_concurrency,
                            "Resolving games with bounded concurrency"
                        );

                        let resolved_games: Vec<ResolvedGame> = run_bounded(
                            game_resolvers.into_iter().map(|game_resolver| {
                                let db_pool = db_pool.clone();
                                async move { game_resolver.resolve(db_pool.clone()).await }
                            }),
                            scan_concurrency,
                        )
                        .await
                        .into_iter()
                        .filter_map(|handle| match handle {
                            Ok(game) => Some(game),
                            Err(why) => {
                                warn!("Failed to resolve game: {:#?}", why);
                                None
                            }
                        })
                        .collect();

                        let _ = run_bounded(
                            resolved_games.into_iter().map(|resolved_game| {
                                let db_pool = db_pool.clone();
                                async move { resolved_game.resolve_files(db_pool.clone()).await }
                            }),
                            scan_concurrency,
                        )
                        .await;

                        Ok(())
                    }
                })
        })
        .collect();

    let steam_provider = state.steam_web_api_client.clone();
    let steam_library_res = steam_provider.get_owned_games().await.ok();

    let steam_tasks: Vec<_> = if let Some(steam_library_res) = steam_library_res {
        let db_pool = db_pool.clone();
        let mut conn = db_pool.get().await.unwrap();

        let steam_platform_id: i32 = schema::platforms::table
            .select(schema::platforms::id)
            .filter(schema::platforms::path.eq("__RETROM_RESERVED__/Steam"))
            .first(&mut conn)
            .await
            .expect("Could not fetch Steam platform ID");

        steam_library_res
            .response
            .games
            .into_iter()
            .map(|game| {
                let db_pool = db_pool.clone();

                async move {
                    let mut conn = db_pool.get().await.unwrap();

                    let new_game = NewGame {
                        platform_id: Some(steam_platform_id),
                        path: game.name,
                        third_party: Some(true),
                        steam_app_id: game.appid.to_i64(),
                        storage_type: Some(StorageType::SingleFileGame.into()),
                        ..Default::default()
                    };

                    if new_game.steam_app_id.is_none() {
                        tracing::warn!("Game {} has no parsable Steam App ID", new_game.path);
                        return Ok(());
                    }

                    diesel::insert_into(schema::games::table)
                        .values(&new_game)
                        .on_conflict_do_nothing()
                        .execute(&mut conn)
                        .await?;

                    Ok::<(), diesel::result::Error>(())
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut job_ids = vec![];

    if !tasks.is_empty() {
        let job_id = match state.job_manager.spawn("Update Library", tasks, None).await {
            Ok(job_id) => job_id,
            Err(JobError::JobAlreadyRunning(name)) => return Err(Status::already_exists(name)),
            Err(why) => return Err(Status::internal(format!("Failed to spawn job: {why}"))),
        };

        job_ids.push(job_id.into());
    }

    if !steam_tasks.is_empty() {
        let job_id = match state
            .job_manager
            .spawn("Update Steam Library", steam_tasks, None)
            .await
        {
            Ok(job_id) => job_id,
            Err(JobError::JobAlreadyRunning(name)) => return Err(Status::already_exists(name)),
            Err(why) => return Err(Status::internal(format!("Failed to spawn job: {why}"))),
        };

        job_ids.push(job_id.into());
    }

    if job_ids.is_empty() {
        return Err(Status::internal("No library content found"));
    }

    Ok(UpdateLibraryResponse { job_ids })
}
