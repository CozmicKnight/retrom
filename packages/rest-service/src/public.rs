use axum::{
    body::Bytes,
    extract::{Extension, Path},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any_service, get},
    Json, Router,
};
use futures_util::TryStreamExt;
use retrom_codegen::retrom::{files::File, FilesystemNodeType};
use retrom_service_common::{
    config::{resolve_metadata_path, ServerConfigManager},
    retrom_dirs::RetromDirs,
};
use std::{
    path::{Component, PathBuf},
    sync::Arc,
};
use tokio::fs::File as TokioFile;
use tokio_util::io::ReaderStream;
use tower_http::services::ServeDir;

pub fn public_routes(config_manager: Arc<ServerConfigManager>) -> Router {
    let public_dir = RetromDirs::new().public_dir().clone();
    let dir_service = ServeDir::new(public_dir);

    Router::new()
        .route("/media/{*tail}", get(get_metadata_file))
        .route(
            "/{*tail}",
            any_service(dir_service).post(post_file).delete(delete_file),
        )
        .layer(Extension(config_manager))
}

async fn get_metadata_file(
    Extension(config_manager): Extension<Arc<ServerConfigManager>>,
    Path(tail): Path<String>,
) -> Result<Response, StatusCode> {
    let relative_path = sanitize_relative_path(&tail).ok_or(StatusCode::BAD_REQUEST)?;
    let config = config_manager.get_config().await;
    let metadata_dir = resolve_metadata_path(config.metadata.as_ref());
    let path = metadata_dir.join(relative_path);

    let file = TokioFile::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let body = axum::body::Body::from_stream(ReaderStream::new(file).map_ok(Bytes::from));
    let content_type = get_content_type(&path);

    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[tracing::instrument]
async fn post_file(Json(file): Json<File>) -> Result<Response, StatusCode> {
    let stat = match file.stat {
        Some(stat) => stat,
        None => return Err(StatusCode::BAD_REQUEST),
    };

    if PathBuf::from(&stat.path).is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let path = RetromDirs::new().public_dir().join(stat.path);

    match FilesystemNodeType::try_from(stat.node_type) {
        Ok(FilesystemNodeType::File) => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| StatusCode::NOT_FOUND)?;
            }
        }
        _ => return Err(StatusCode::BAD_REQUEST),
    }

    tokio::fs::write(&path, file.content)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tracing::info!("File written to {:?}", path);

    Ok((StatusCode::CREATED, "Created").into_response())
}

#[tracing::instrument]
async fn delete_file(tail: Uri) -> Result<Response, StatusCode> {
    let path = RetromDirs::new().public_dir().join(tail.path());

    tracing::info!("Deleting filesystem entry at {:?}", tail.path());
    if !path.exists() {
        tracing::warn!("Filesystem entry not found at {:?}", path);
        return Err(StatusCode::NOT_FOUND);
    }

    match path.is_file() {
        true => {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|_| StatusCode::NOT_FOUND)?;
        }
        false => {
            tokio::fs::remove_dir_all(&path)
                .await
                .map_err(|_| StatusCode::NOT_FOUND)?;
        }
    }

    tracing::info!("Filesystem entry deleted from {:?}", path);

    Ok((StatusCode::OK, "Deleted").into_response())
}

fn sanitize_relative_path(path: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        return None;
    }

    let mut sanitized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => sanitized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => return None,
        }
    }

    Some(sanitized)
}

fn get_content_type(path: &PathBuf) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
