use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use uuid::Uuid;
use zip::ZipArchive;

// 获取应用数据目录的辅助函数
fn get_app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .expect("Failed to get app data directory")
        .join("Kabegami Crawler")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub enabled: bool,
    pub config: HashMap<String, serde_json::Value>,
    pub selector: Option<PluginSelector>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSelector {
    #[serde(rename = "imageSelector")]
    pub image_selector: String,
    #[serde(rename = "nextPageSelector")]
    pub next_page_selector: Option<String>,
    #[serde(rename = "titleSelector")]
    pub title_selector: Option<String>,
}

pub struct PluginManager {
    app: AppHandle,
}

impl PluginManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn get_plugins_file(&self) -> PathBuf {
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("plugins.json")
    }

    /// 从插件目录中的 .kgpg 文件加载所有已安装的插件
    pub fn get_all(&self) -> Result<Vec<Plugin>, String> {
        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            return Ok(vec![]);
        }

        let mut plugins = Vec::new();
        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            // 只处理 .kgpg 文件
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let config = self.read_plugin_config(&path)?;

                    // 使用文件名和插件名生成 ID，与 load_browser_plugins 保持一致
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let plugin_id = format!("{}-{}", file_name, manifest.name);

                    let plugin = Plugin {
                        id: plugin_id,
                        name: manifest.name.clone(),
                        description: manifest.description,
                        base_url: config
                            .as_ref()
                            .map(|c| c.base_url.clone())
                            .unwrap_or_default(),
                        enabled: true,
                        config: HashMap::new(),
                        selector: config.and_then(|c| c.selector),
                    };
                    plugins.push(plugin);
                }
            }
        }

        Ok(plugins)
    }

    /// 不再需要保存到文件，插件信息直接从 .kgpg 文件读取
    pub fn save_all(&self, _plugins: &[Plugin]) -> Result<(), String> {
        // 插件信息现在直接从文件系统读取，不需要保存
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Plugin> {
        let plugins = self.get_all().ok()?;
        plugins.into_iter().find(|p| p.id == id)
    }

    /// 添加插件（实际上是通过复制 .kgpg 文件实现的）
    pub fn add(&self, _plugin: Plugin) -> Result<Plugin, String> {
        // 插件添加通过复制 .kgpg 文件实现，不需要在这里处理
        // 这个方法保留是为了兼容性，但实际不会使用
        Err(
            "Use install_plugin_from_zip or copy .kgpg file to plugins directory instead"
                .to_string(),
        )
    }

    /// 更新插件配置（只更新 enabled 状态，其他信息从 .kgpg 文件读取）
    pub fn update(
        &self,
        id: &str,
        updates: HashMap<String, serde_json::Value>,
    ) -> Result<Plugin, String> {
        // 插件信息现在直接从 .kgpg 文件读取
        // 只允许更新 enabled 状态，其他信息不能修改
        // 如果需要修改插件信息，需要重新安装插件

        // 先获取插件
        let mut plugin = self
            .get(id)
            .ok_or_else(|| format!("Plugin {} not found", id))?;

        // 只更新 enabled 状态
        if let Some(enabled) = updates.get("enabled").and_then(|v| v.as_bool()) {
            plugin.enabled = enabled;
            // 可以将 enabled 状态保存到单独的配置文件
            // 目前暂时不保存，因为插件信息每次都从文件读取
        }

        Ok(plugin)
    }

    /// 删除插件（删除对应的 .kgpg 文件）
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            return Err(format!("Plugin {} not found", id));
        }

        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let plugin_id = format!("{}-{}", file_name, manifest.name);

                    if plugin_id == id {
                        fs::remove_file(&path)
                            .map_err(|e| format!("Failed to delete plugin file: {}", e))?;
                        return Ok(());
                    }
                }
            }
        }

        Err(format!("Plugin {} not found", id))
    }

    pub fn get_plugins_directory(&self) -> PathBuf {
        // 开发模式：使用 test_plugin_packed 目录
        // 生产模式：使用应用数据目录
        #[cfg(debug_assertions)]
        {
            // 开发模式：尝试多个可能的路径
            // 1. 当前工作目录（开发时通常在项目根目录）
            if let Ok(cwd) = std::env::current_dir() {
                let dev_path = cwd.join("test_plugin_packed");
                if dev_path.exists() {
                    return dev_path;
                }
            }

            // 2. 从可执行文件位置查找
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    // 在开发模式下，可执行文件在 target/debug，需要向上到项目根目录
                    if let Some(project_root) = exe_dir
                        .parent() // target
                        .and_then(|p| p.parent()) // src-tauri
                        .and_then(|p| p.parent())
                    // 项目根目录
                    {
                        let dev_path = project_root.join("test_plugin_packed");
                        if dev_path.exists() {
                            return dev_path;
                        }
                    }
                }
            }
        }

        // 生产模式或开发模式但 test_plugin_packed 不存在时，使用应用数据目录
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("plugins_directory")
    }

    pub fn get_favorites_file(&self) -> PathBuf {
        let app_data_dir = get_app_data_dir();
        app_data_dir.join("plugin_favorites.json")
    }

    pub fn load_browser_plugins(&self) -> Result<Vec<BrowserPlugin>, String> {
        let plugins_dir = self.get_plugins_directory();
        if !plugins_dir.exists() {
            // 开发模式下，如果 test_plugin_packed 不存在，返回空列表
            #[cfg(debug_assertions)]
            return Ok(vec![]);

            // 生产模式下，创建目录
            #[cfg(not(debug_assertions))]
            {
                fs::create_dir_all(&plugins_dir)
                    .map_err(|e| format!("Failed to create plugins directory: {}", e))?;
                return Ok(vec![]);
            }
        }

        let favorites = self.load_favorites()?;
        let mut browser_plugins = Vec::new();

        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            // 只支持 .kgpg 文件格式
            if path.is_file() {
                let ext = path.extension().and_then(|s| s.to_str());
                if ext == Some("kgpg") {
                    // 读取 ZIP 格式的插件
                    if let Ok(manifest) = self.read_plugin_manifest(&path) {
                        let file_name = path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        let plugin_id = format!("{}-{}", file_name, manifest.name);
                        let favorite = favorites.contains(&plugin_id);

                        // 读取 doc.md（可选）
                        let doc = self.read_plugin_doc(&path).ok().flatten();

                        // 检查图标是否存在
                        let icon_path = if self.check_plugin_icon_exists(&path) {
                            Some(path.to_string_lossy().to_string())
                        } else {
                            None
                        };

                        browser_plugins.push(BrowserPlugin {
                            id: plugin_id,
                            name: manifest.name,
                            desp: manifest.description,
                            icon: icon_path, // 如果图标存在，存储插件文件路径
                            favorite,
                            file_path: Some(path.to_string_lossy().to_string()),
                            doc, // 添加 doc 字段
                        });
                    }
                }
            }
        }

        Ok(browser_plugins)
    }

    fn load_plugin_from_file(&self, path: &Path) -> Result<PluginJson, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read plugin file: {}", e))?;
        let plugin_json: PluginJson = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse plugin JSON: {}", e))?;
        Ok(plugin_json)
    }

    /// 从 ZIP 格式的插件文件中读取 manifest.json
    pub fn read_plugin_manifest(&self, zip_path: &Path) -> Result<PluginManifest, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 只读取 manifest.json，不解压整个文件
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| "manifest.json not found in plugin archive")?;

        let mut content = String::new();
        manifest_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;

        let manifest: PluginManifest = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;
        Ok(manifest)
    }

    /// 从 ZIP 格式的插件文件中读取 doc_root/doc.md
    fn read_plugin_doc(&self, zip_path: &Path) -> Result<Option<String>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 优先从 doc_root/doc.md 读取，如果没有则尝试 doc.md（向后兼容）
        let doc_paths = ["doc_root/doc.md", "doc.md"];
        let mut doc_path_found = None;

        for doc_path in &doc_paths {
            if archive.by_name(doc_path).is_ok() {
                doc_path_found = Some(*doc_path);
                break;
            }
        }

        let doc_path = match doc_path_found {
            Some(p) => p,
            None => return Ok(None), // doc.md 是可选的
        };

        let mut doc_file = archive.by_name(doc_path).map_err(|_| "doc.md not found")?;

        let mut content = String::new();
        doc_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read doc.md: {}", e))?;

        Ok(Some(content))
    }

    /// 从 ZIP 格式的插件文件中读取图片资源（用于 doc_root 下的图片）
    pub fn read_plugin_image(&self, zip_path: &Path, image_path: &str) -> Result<Vec<u8>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        // 规范化图片路径
        let mut normalized_path = image_path.trim().to_string();

        // 安全检查 1: 拒绝绝对路径
        if normalized_path.starts_with('/') || normalized_path.starts_with("\\") {
            return Err("Absolute paths are not allowed".to_string());
        }

        // URL 解码（处理 %20 等编码字符）
        // 手动替换常见的 URL 编码字符
        normalized_path = normalized_path
            .replace("%20", " ")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%2F", "/")
            .replace("%5C", "\\")
            .replace("%2E", "."); // 解码 . 字符

        // 安全检查 2: 拒绝路径遍历攻击（../ 和 ..\）
        // 检查各种可能的路径遍历形式
        if normalized_path.contains("../")
            || normalized_path.contains("..\\")
            || normalized_path.contains("..%2F") // URL 编码的 ../
            || normalized_path.contains("..%5C") // URL 编码的 ..\
            || normalized_path.starts_with("..")
        {
            return Err("Path traversal attacks are not allowed".to_string());
        }

        // 移除 ./ 前缀
        if normalized_path.starts_with("./") {
            normalized_path = normalized_path[2..].to_string();
        }

        // 移除 doc_root/ 前缀（如果存在）
        if normalized_path.starts_with("doc_root/") {
            normalized_path = normalized_path[9..].to_string();
        }

        // 规范化路径分隔符（Windows 使用 \，但 ZIP 内部使用 /）
        normalized_path = normalized_path.replace('\\', "/");

        // 安全检查 3: 再次检查规范化后的路径（防止双重编码等攻击）
        if normalized_path.contains("../") || normalized_path.starts_with("..") {
            return Err("Path traversal detected after normalization".to_string());
        }

        // 安全检查 4: 确保路径不为空，且不包含控制字符
        if normalized_path.is_empty() {
            return Err("Empty image path is not allowed".to_string());
        }
        if normalized_path.chars().any(|c| c.is_control()) {
            return Err("Control characters in path are not allowed".to_string());
        }

        // 确保路径在 doc_root 目录下（安全限制）
        let final_path = format!("doc_root/{}", normalized_path);

        // 安全检查 5: 最终验证路径确实在 doc_root 下
        // 规范化最终路径，检查是否包含路径遍历
        if final_path.contains("../") || final_path.starts_with("../") {
            return Err("Final path validation failed".to_string());
        }

        let mut image_file = archive.by_name(&final_path).map_err(|e| {
            format!(
                "Image {} not found in plugin archive. Error: {:?}",
                final_path, e
            )
        })?;

        let mut image_data = Vec::new();
        image_file
            .read_to_end(&mut image_data)
            .map_err(|e| format!("Failed to read image: {}", e))?;

        Ok(image_data)
    }

    /// 从 ZIP 格式的插件文件中读取 crawl.rhai 脚本
    pub fn read_plugin_script(&self, zip_path: &Path) -> Result<Option<String>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut script_file = match archive.by_name("crawl.rhai") {
            Ok(f) => f,
            Err(_) => return Ok(None), // crawl.rhai 是可选的
        };

        let mut content = String::new();
        script_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read crawl.rhai: {}", e))?;
        Ok(Some(content))
    }

    /// 检查插件 ZIP 文件中是否存在 icon.ico
    fn check_plugin_icon_exists(&self, zip_path: &Path) -> bool {
        if let Ok(file) = fs::File::open(zip_path) {
            if let Ok(mut archive) = ZipArchive::new(file) {
                return archive.by_name("icon.ico").is_ok();
            }
        }
        false
    }

    /// 从 ZIP 格式的插件文件中读取 icon.ico
    pub fn read_plugin_icon(&self, zip_path: &Path) -> Result<Option<Vec<u8>>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut icon_file = match archive.by_name("icon.ico") {
            Ok(f) => f,
            Err(_) => return Ok(None), // icon.ico 是可选的
        };

        let mut icon_data = Vec::new();
        icon_file
            .read_to_end(&mut icon_data)
            .map_err(|e| format!("Failed to read icon.ico: {}", e))?;

        Ok(Some(icon_data))
    }

    /// 从 ZIP 格式的插件文件中读取 config.json
    fn read_plugin_config(&self, zip_path: &Path) -> Result<Option<PluginConfig>, String> {
        let file =
            fs::File::open(zip_path).map_err(|e| format!("Failed to open plugin file: {}", e))?;
        let mut archive =
            ZipArchive::new(file).map_err(|e| format!("Failed to open ZIP archive: {}", e))?;

        let mut config_file = match archive.by_name("config.json") {
            Ok(f) => f,
            Err(_) => return Ok(None), // config.json 是可选的
        };

        let mut content = String::new();
        config_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed to read config.json: {}", e))?;

        let config: PluginConfig = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config.json: {}", e))?;
        Ok(Some(config))
    }

    /// 安装 .kgpg 插件（复制文件到插件目录）
    pub fn install_plugin_from_zip(&self, zip_path: &Path) -> Result<Plugin, String> {
        // 读取 manifest 以获取插件信息
        let manifest = self.read_plugin_manifest(zip_path)?;

        // 读取 config（如果存在）
        let config = self.read_plugin_config(zip_path)?;

        // 获取插件目录
        let plugins_dir = self.get_plugins_directory();
        fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

        // 获取源文件名
        let file_name = zip_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;

        // 目标文件路径
        let target_path = plugins_dir.join(file_name);

        // 如果目标文件已存在，先删除
        if target_path.exists() {
            fs::remove_file(&target_path)
                .map_err(|e| format!("Failed to remove existing plugin file: {}", e))?;
        }

        // 复制 .kgpg 文件到插件目录
        fs::copy(zip_path, &target_path)
            .map_err(|e| format!("Failed to copy plugin file: {}", e))?;

        // 构建 Plugin 对象（从复制的文件中读取）
        let file_stem = zip_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let plugin_id = format!("{}-{}", file_stem, manifest.name);

        let plugin = Plugin {
            id: plugin_id,
            name: manifest.name.clone(),
            description: manifest.description,
            base_url: config
                .as_ref()
                .map(|c| c.base_url.clone())
                .unwrap_or_default(),
            enabled: true,
            config: HashMap::new(),
            selector: config.and_then(|c| c.selector),
        };

        Ok(plugin)
    }

    pub fn import_plugin_from_json(
        &self,
        plugin_json: PluginJson,
        file_name: String,
    ) -> Result<Plugin, String> {
        // 保存到插件目录
        let plugins_dir = self.get_plugins_directory();
        fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

        let file_path = plugins_dir.join(&file_name);
        let content = serde_json::to_string_pretty(&plugin_json)
            .map_err(|e| format!("Failed to serialize plugin: {}", e))?;
        fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write plugin file: {}", e))?;

        // 转换为 Plugin 并添加到已安装列表
        let plugin = Plugin {
            id: Uuid::new_v4().to_string(),
            name: plugin_json.name.clone(),
            description: plugin_json.desp.clone(),
            base_url: String::new(), // 需要从 JSON 中获取或使用默认值
            enabled: true,
            config: HashMap::new(),
            selector: None,
        };

        self.add(plugin.clone())?;
        Ok(plugin)
    }

    /// 安装浏览器插件（从插件目录中的 .kgpg 文件安装）
    /// 实际上，如果文件已经在插件目录中，就已经是"已安装"状态了
    /// 这个方法主要用于标记插件为已安装（如果之前未安装的话）
    pub fn install_browser_plugin(&self, plugin_id: String) -> Result<Plugin, String> {
        let plugins_dir = self.get_plugins_directory();
        let entries = fs::read_dir(&plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let generated_id = format!("{}-{}", file_name, manifest.name);

                    if generated_id == plugin_id || file_name == plugin_id {
                        // 文件已经在插件目录中，直接读取并返回
                        let config = self.read_plugin_config(&path)?;
                        let plugin = Plugin {
                            id: generated_id,
                            name: manifest.name.clone(),
                            description: manifest.description,
                            base_url: config
                                .as_ref()
                                .map(|c| c.base_url.clone())
                                .unwrap_or_default(),
                            enabled: true,
                            config: HashMap::new(),
                            selector: config.and_then(|c| c.selector),
                        };
                        return Ok(plugin);
                    }
                }
            }
        }

        Err(format!("Plugin {} not found", plugin_id))
    }

    fn load_favorites(&self) -> Result<Vec<String>, String> {
        let file = self.get_favorites_file();
        if !file.exists() {
            return Ok(vec![]);
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read favorites file: {}", e))?;
        let favorites: Vec<String> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse favorites: {}", e))?;
        Ok(favorites)
    }

    fn save_favorites(&self, favorites: &[String]) -> Result<(), String> {
        let file = self.get_favorites_file();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create favorites directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(favorites)
            .map_err(|e| format!("Failed to serialize favorites: {}", e))?;
        fs::write(&file, content).map_err(|e| format!("Failed to write favorites file: {}", e))?;
        Ok(())
    }

    pub fn toggle_favorite(&self, plugin_id: String, favorite: bool) -> Result<(), String> {
        let mut favorites = self.load_favorites()?;
        if favorite {
            if !favorites.contains(&plugin_id) {
                favorites.push(plugin_id);
            }
        } else {
            favorites.retain(|id| id != &plugin_id);
        }
        self.save_favorites(&favorites)?;
        Ok(())
    }

    /// 获取插件的变量定义（从 config.json 中读取）
    pub fn get_plugin_vars(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Vec<VarDefinition>>, String> {
        let plugins_dir = self.get_plugins_directory();
        let plugin_file = self.find_plugin_file(&plugins_dir, plugin_id)?;
        let config = self.read_plugin_config(&plugin_file)?;
        Ok(config.and_then(|c| c.var))
    }

    /// 加载用户对插件的配置
    pub fn load_plugin_config(
        &self,
        plugin_id: &str,
    ) -> Result<HashMap<String, serde_json::Value>, String> {
        let file = self.get_plugin_config_file(plugin_id);
        if !file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&file)
            .map_err(|e| format!("Failed to read plugin config: {}", e))?;
        let config: HashMap<String, serde_json::Value> = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse plugin config: {}", e))?;
        Ok(config)
    }

    /// 保存用户对插件的配置
    pub fn save_plugin_config(
        &self,
        plugin_id: &str,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<(), String> {
        let file = self.get_plugin_config_file(plugin_id);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize plugin config: {}", e))?;
        fs::write(&file, content).map_err(|e| format!("Failed to write plugin config: {}", e))?;
        Ok(())
    }

    /// 获取插件配置文件的路径
    fn get_plugin_config_file(&self, plugin_id: &str) -> PathBuf {
        let data_dir = get_app_data_dir();
        let config_dir = data_dir.join("plugin_configs");
        config_dir.join(format!("{}.json", plugin_id))
    }

    /// 查找插件文件
    fn find_plugin_file(&self, plugins_dir: &Path, plugin_id: &str) -> Result<PathBuf, String> {
        let entries = fs::read_dir(plugins_dir)
            .map_err(|e| format!("Failed to read plugins directory: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();

            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("kgpg") {
                if let Ok(manifest) = self.read_plugin_manifest(&path) {
                    let file_name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    let id = format!("{}-{}", file_name, manifest.name);
                    if id == plugin_id {
                        return Ok(path);
                    }
                }
            }
        }

        Err(format!("Plugin {} not found", plugin_id))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserPlugin {
    pub id: String,
    pub name: String,
    pub desp: String,
    pub icon: Option<String>,
    pub favorite: bool,
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginJson {
    pub name: String,
    #[serde(default)]
    pub desp: String,
    #[serde(default)]
    pub icon: Option<String>,
}

// 插件清单（manifest.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
}

// 变量定义（config.json 中的 var 字段，现在是数组格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VarDefinition {
    pub key: String, // 变量名（用于在脚本中引用）
    #[serde(rename = "type")]
    pub var_type: String, // "int", "float", "options", "boolean", "list"
    pub name: String, // 展示给用户的名称
    #[serde(default)]
    pub descripts: Option<String>, // 描述（注意：用户写的是 descripts，不是 description）
    #[serde(default)]
    pub default: Option<serde_json::Value>, // 默认值
    #[serde(default)]
    pub options: Option<Vec<String>>, // options 类型的选项列表
}

// 插件配置（config.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    // 注意：selector 字段已废弃，选择器现在在 crawl.rhai 脚本中定义
    // 保留此字段仅用于向后兼容，新插件不应使用
    #[serde(default)]
    pub selector: Option<PluginSelector>,
    // 变量定义（可选，数组格式以保持顺序）
    #[serde(default)]
    pub var: Option<Vec<VarDefinition>>,
}
