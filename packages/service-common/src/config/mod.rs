use crate::retrom_dirs::RetromDirs;
use config::{Config, ConfigError, File};
use retrom_codegen::retrom::{
    metadata_config::OptimizationConfig, ContentDirectory, MetadataConfig, SavesConfig,
    ServerConfig, StorageType,
};
use std::path::PathBuf;
use tokio::sync::RwLock;

#[derive(thiserror::Error, Debug)]
pub enum RetromConfigError {
    #[error("Error parsing config: {0}")]
    ParseError(#[from] ConfigError),
    #[error("Config path not provided: {0}")]
    ConfigNotProvided(#[from] std::env::VarError),
    #[error("Config file error: {0}")]
    ConfigFileError(#[from] tokio::io::Error),
    #[error("Could not (de)serialize config: {0}")]
    ConfigSerializationError(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, RetromConfigError>;

pub fn default_metadata_path() -> PathBuf {
    RetromDirs::new().media_dir()
}

pub fn resolve_metadata_path(config: Option<&MetadataConfig>) -> PathBuf {
    config
        .and_then(|metadata| {
            let path = metadata.path.trim();
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        })
        .unwrap_or_else(default_metadata_path)
}

pub struct ServerConfigManager {
    config: RwLock<ServerConfig>,
    config_path: PathBuf,
}

impl ServerConfigManager {
    fn default_metadata_optimization_config() -> OptimizationConfig {
        OptimizationConfig {
            jpeg_quality: 85,
            jpeg_optimization: false,
            webp_quality: 85,
            webp_lossless: true,
            png_quality: 85,
            png_optimization_level: 2,
            png_optimization: true,
            preferred_image_format: None,
        }
    }

    fn default_metadata_config() -> MetadataConfig {
        MetadataConfig {
            store_metadata_locally: false,
            smart_structure_enabled: false,
            path: default_metadata_path().to_string_lossy().to_string(),
            optimization: Some(Self::default_metadata_optimization_config()),
        }
    }

    fn with_runtime_defaults(mut config: ServerConfig) -> ServerConfig {
        let metadata = config
            .metadata
            .get_or_insert_with(Self::default_metadata_config);

        if metadata.path.trim().is_empty() {
            metadata.path = default_metadata_path().to_string_lossy().to_string();
        }

        metadata
            .optimization
            .get_or_insert_with(Self::default_metadata_optimization_config);

        metadata.smart_structure_enabled = config
            .content_directories
            .iter()
            .any(|content_directory| content_directory.smart_structure_enabled);

        config
    }

    fn get_default_config() -> ServerConfig {
        ServerConfig {
            content_directories: vec![ContentDirectory {
                path: "/app/library".into(),
                storage_type: Some(i32::from(StorageType::MultiFileGame)),
                ignore_patterns: None,
                custom_library_definition: None,
                smart_structure_enabled: false,
            }],
            saves: Some(SavesConfig {
                max_save_files_backups: 5,
                max_save_states_backups: 5,
            }),
            metadata: Some(Self::default_metadata_config()),
            ..Default::default()
        }
    }

    pub fn new() -> Result<Self> {
        dotenvy::dotenv().ok();
        let dirs = RetromDirs::new();
        let config_path_str = std::env::var("RETROM_CONFIG").ok();
        let config_path = match config_path_str {
            Some(config_path_str) => PathBuf::from(&config_path_str),
            None => dirs.config_dir().join("config.json"),
        };

        tracing::debug!("Config path: {:?}", config_path);

        if !config_path.exists() {
            let default_config = ServerConfigManager::get_default_config();

            tracing::info!("Config file does not exist, creating...");

            std::fs::create_dir_all(config_path.parent().unwrap())?;

            let data = serde_json::to_vec_pretty(&default_config)?;
            std::fs::write(&config_path, data)?;

            tracing::info!("Config file created at {:?}", config_path);
        }

        let config = RwLock::new(Self::read_config_file(
            config_path
                .to_str()
                .expect("Could not stringify config path"),
        )?);

        Ok(Self {
            config,
            config_path,
        })
    }

    pub async fn get_config(&self) -> ServerConfig {
        Self::with_runtime_defaults(self.config.read().await.clone())
    }

    pub fn get_config_blocking(&self) -> ServerConfig {
        Self::with_runtime_defaults(self.config.blocking_read().clone())
    }

    pub async fn update_config(&self, config: ServerConfig) -> Result<()> {
        let config = Self::with_runtime_defaults(config);
        let data = serde_json::to_vec_pretty(&config)?;
        tokio::fs::write(&self.config_path, data).await?;
        *self.config.write().await = config;

        Ok(())
    }

    fn read_config_file(path: &str) -> Result<ServerConfig> {
        dotenvy::dotenv().ok();

        if std::env::var("RETROM_PORT").is_ok() {
            tracing::error!(
                "RETROM_PORT env var is deprecated, use a config file override instead."
            );
        }

        if std::env::var("DATABASE_URL").is_ok() {
            tracing::error!(
                "DATABASE_URL env var is deprecated, use a config file override instead."
            );
        }

        if std::env::var("IGDB_CLIENT_ID").is_ok() {
            tracing::error!(
                "IGDB_CLIENT_ID env var is deprecated, use the retrom client to configure IGDB"
            );
        }

        if std::env::var("IGDB_CLIENT_SECRET").is_ok() {
            tracing::error!(
                "IGDB_CLIENT_SECRET env var is deprecated, use the retrom client to configure IGDB"
            );
        }

        let config = Config::builder().add_source(File::with_name(path));

        let mut s: ServerConfig = config.build()?.try_deserialize()?;

        if let Ok(content_dir) = std::env::var("CONTENT_DIR") {
            tracing::warn!("CONTENT_DIR env var is deprecated");
            s.content_directories.push(ContentDirectory {
                path: content_dir,
                storage_type: Some(i32::from(StorageType::MultiFileGame)),
                ignore_patterns: None,
                custom_library_definition: None,
                smart_structure_enabled: false,
            });
        }

        Ok(Self::with_runtime_defaults(s))
    }
}
