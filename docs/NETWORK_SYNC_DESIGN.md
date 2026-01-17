# 局域网同步技术方案设计文档

## 1. 设计背景

### 1.1 项目现状

Kabegame 是一个基于 Tauri 的二次元壁纸管理器，核心架构包含：

- **Provider 系统**：通过 `Provider` trait 统一抽象所有数据源（画册、按插件、按时间等）
- **虚拟盘系统**：在 Windows 上将 Provider 数据挂载为虚拟磁盘
- **Gallery 浏览系统**：基于 Provider 路径浏览图片
- **爬虫插件系统**：使用 Rhai 脚本从网站爬取壁纸，支持 `to_json()` 和 `download_image()` 等 API

### 1.2 设计目标

实现局域网设备间的数据同步（图片、画册等），要求：

1. **复用现有系统**：充分利用 Provider 架构，避免重复开发
2. **统一体验**：远程数据与本地数据使用相同的接口和体验
3. **插件兼容**：爬虫插件可以像访问网站一样访问局域网设备
4. **支持嵌套**：支持通过设备 A 访问设备 B，再通过设备 B 访问设备 C

## 2. 核心设计思路

### 2.1 设计原则

- **零侵入扩展**：不修改现有 Provider trait、Descriptor、Factory
- **统一抽象**：远程数据通过 Provider 接口访问，与本地数据一致
- **最小改动**：HTTP 层只做路径转换和 JSON 序列化
- **递归支持**：支持任意深度的嵌套网络访问

### 2.2 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    用户界面层                            │
│  (虚拟盘 / Gallery / 插件脚本)                          │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Provider trait
                     │
┌────────────────────┴────────────────────────────────────┐
│                   Provider 层                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │本地 Provider │  │网络 Provider │  │嵌套网络 Provider││
│  └──────────────┘  └──────┬───────┘  └──────┬───────┘  │
└───────────────────────────┼──────────────────┼──────────┘
                            │                  │
                            │ HTTP API         │ HTTP 转发
                            │                  │
┌───────────────────────────┴──────────────────┴──────────┐
│                    HTTP 服务器层                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │ HTTP 请求 → IPC 请求转换                         │  │
│  │ /api/provider/albums → CliIpcRequest::          │  │
│  │   GalleryBrowseProvider { path: "albums" }       │  │
│  └────────────────────┬─────────────────────────────┘  │
└───────────────────────┼─────────────────────────────────┘
                        │ IPC (Unix Socket / Named Pipe)
                        │
┌───────────────────────┴─────────────────────────────────┐
│                      Daemon 层                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 业务逻辑处理：                                    │  │
│  │ - Storage 操作                                    │  │
│  │ - Provider 解析                                   │  │
│  │ - 任务调度                                        │  │
│  │ - 事件广播                                        │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**设计要点**：
- **HTTP 服务器作为前端**：只负责协议转换（HTTP ↔ IPC）
- **Daemon 作为后端**：集中处理所有业务逻辑
- **职责分离**：HTTP 层不包含业务逻辑，daemon 不关心传输协议

## 3. HTTP API 设计

### 3.1 架构原则

**HTTP 服务器作为 daemon 的前端**：
- HTTP 服务器只负责协议转换（HTTP ↔ IPC）
- 所有业务逻辑由 daemon 处理
- 通过 IPC（Unix Socket / Named Pipe）与 daemon 通信

### 3.2 API 端点

```
GET  /api/provider                    # 根目录
GET  /api/provider/*path              # Provider 路径
GET  /api/provider/*path/file/:name   # 文件下载
GET  /api/forward/:device/provider/*path  # 转发请求（嵌套访问）
GET  /api/status                      # 设备状态
```

### 3.3 请求转换流程

```
HTTP 请求
    ↓
HTTP 服务器接收
    ↓
转换为 IPC 请求 (CliIpcRequest)
    ↓
通过 IPC 调用 daemon
    ↓
Daemon 处理业务逻辑
    ↓
返回 IPC 响应 (CliIpcResponse)
    ↓
转换为 HTTP 响应
    ↓
返回给客户端
```

### 3.4 路径映射

HTTP 路径转换为 IPC 请求：

```
HTTP 路径                          IPC 请求
/api/provider                     CliIpcRequest::GalleryBrowseProvider { path: "" }
/api/provider/albums              CliIpcRequest::GalleryBrowseProvider { path: "albums" }
/api/provider/albums/my-album     CliIpcRequest::GalleryBrowseProvider { path: "albums/my-album" }
```

### 3.5 响应格式

```json
{
  "entries": [
    {
      "type": "directory",
      "name": "画册"
    },
    {
      "type": "file",
      "name": "image.jpg",
      "imageId": "123",
      "url": "/api/provider/albums/my-album/file/image.jpg"
    }
  ]
}
```

### 3.6 实现要点

```rust
// HTTP 服务器：协议转换层
async fn handle_provider_path(
    Path(path): Path<String>,
    State(state): State<Arc<HttpServerState>>,
) -> Result<Json<ProviderResponse>, StatusCode> {
    // 1. 构建 IPC 请求
    let ipc_request = CliIpcRequest::GalleryBrowseProvider {
        path: path.clone(),
    };
    
    // 2. 通过 IPC 调用 daemon
    let ipc_response = state.ipc_client
        .request(ipc_request)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // 3. 检查 IPC 响应
    if !ipc_response.ok {
        return Err(StatusCode::from(
            ipc_response.message.unwrap_or_default()
        ));
    }
    
    // 4. 提取数据并转换为 HTTP 响应
    let data: GalleryBrowseResult = serde_json::from_value(
        ipc_response.data.unwrap_or_default()
    ).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    
    // 5. 转换为 ProviderResponse 格式
    let response = ProviderResponse::from(data);
    Ok(Json(response))
}
```

**关键优势**：
- **职责分离**：HTTP 服务器只做协议转换，daemon 集中处理业务逻辑
- **代码复用**：daemon 的 handler 可以被多种前端复用（HTTP、WebSocket、gRPC 等）
- **易于测试**：可以独立测试 HTTP 层和 daemon 层
- **易于扩展**：未来可以添加其他传输协议，无需修改 daemon

## 4. 网络虚拟盘设计

### 4.1 NetworkProvider 实现

```rust
pub struct NetworkProvider {
    device: RemoteDevice,
    path: Vec<String>,
    client: reqwest::Client,
    password: Option<String>,
}

impl Provider for NetworkProvider {
    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        // 通过 HTTP 获取远程 Provider 列表
        let url = format!("{}/api/provider/{}", 
            self.device.base_url, self.path.join("/"));
        // ... HTTP 请求 ...
        // 转换为 FsEntry 返回
    }
    
    fn get_child(&self, _storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // 创建子路径的 NetworkProvider
        let mut child_path = self.path.clone();
        child_path.push(name.to_string());
        Some(Arc::new(NetworkProvider::new(...)))
    }
}
```

### 4.2 RootProvider 扩展

在 `RootProvider` 中添加"网络设备"目录：

```rust
impl Provider for RootProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let mut entries = vec![
            FsEntry::dir("全部"),
            FsEntry::dir("画册"),
            // ...
        ];
        
        // 添加网络设备组
        if device_manager.has_devices() {
            entries.push(FsEntry::dir("网络设备"));
        }
        
        Ok(entries)
    }
}
```

### 4.3 虚拟盘集成

虚拟盘自动支持网络目录，用户可以在资源管理器中像浏览本地文件一样浏览网络设备的数据。

## 5. 嵌套网络访问设计

### 5.1 嵌套结构

```
设备 A (本地)
└── 网络设备\
    └── 设备 B\
        ├── 画册\              (设备 B 本地)
        └── 网络设备\         (设备 B 的网络设备)
            └── 设备 C\       (通过设备 B 访问)
                └── ...
```

### 5.2 转发机制

通过中间设备转发请求到目标设备：

```
设备 A → 设备 B: /api/forward/device-c/provider/albums
设备 B → 设备 C: /api/provider/albums
设备 C → 设备 B: JSON 响应
设备 B → 设备 A: JSON 响应
```

### 5.3 NestedNetworkProvider

```rust
pub struct NestedNetworkProvider {
    target_device: RemoteDevice,
    path: Vec<String>,
    intermediate_device: RemoteDevice,  // 中间设备
}

impl Provider for NestedNetworkProvider {
    fn list(&self, _storage: &Storage) -> Result<Vec<FsEntry>, String> {
        // 通过中间设备转发请求
        let url = format!("{}/api/forward/{}/provider/{}",
            self.intermediate_device.base_url,
            self.target_device.device_id,
            self.path.join("/")
        );
        // ... HTTP 请求 ...
    }
}
```

### 5.4 循环检测

在 NetworkProvider 中维护访问链，防止循环：

```rust
pub struct NetworkProvider {
    access_chain: Vec<String>,  // [device-a, device-b, device-c]
}

impl NetworkProvider {
    fn check_cycle(&self, new_device_id: &str) -> bool {
        self.access_chain.contains(&new_device_id.to_string())
    }
}
```

## 6. 安全机制

### 6.1 访问控制

- **服务开关**：默认关闭，用户手动启用
- **密码认证**：SHA256 哈希存储，HTTP 头部传递
- **设备信任**：新设备首次访问需要用户确认
- **速率限制**：防止暴力破解和 DoS 攻击

### 6.2 认证流程

```
客户端请求
    ↓
检查服务是否启用
    ↓
验证密码（如果设置）
    ↓
检查设备是否受信任
    ↓
如果是新设备 → 发送确认请求 → 用户批准
    ↓
允许访问
```

### 6.3 安全设置

```rust
pub struct SyncSecuritySettings {
    pub enabled: bool,
    pub password_hash: Option<String>,
    pub require_confirmation: bool,
    pub trusted_devices: Vec<TrustedDevice>,
    pub rate_limit: Option<u32>,
}
```

## 7. 设备发现

### 7.1 可扩展的设备发现架构

设备发现设计为可扩展的插件化架构，支持多种发现方式：

```rust
// 设备发现器 trait
pub trait DeviceDiscoverer: Send + Sync {
    /// 发现器名称
    fn name(&self) -> &str;
    
    /// 启动发现服务（广播本设备）
    async fn start_service(&self, device: &DeviceInfo) -> Result<(), String>;
    
    /// 发现设备
    async fn discover(&self) -> Result<Vec<DiscoveredDevice>, String>;
    
    /// 是否启用
    fn is_enabled(&self) -> bool;
}

/// 发现的设备信息
#[derive(Debug, Clone)]
pub struct DiscoveredDevice {
    pub device_id: String,
    pub device_name: String,
    pub base_url: String,  // http://ip:port
    pub discoverer: String,  // 发现器名称
    pub metadata: HashMap<String, String>,  // 额外元数据
}
```

### 7.2 内置发现器

#### 7.2.1 mDNS 发现器（默认）

使用 mDNS 自动发现局域网内的设备：

```rust
pub struct MdnsDiscoverer {
    service_name: String,
    enabled: bool,
}

impl DeviceDiscoverer for MdnsDiscoverer {
    fn name(&self) -> &str {
        "mDNS"
    }
    
    async fn start_service(&self, device: &DeviceInfo) -> Result<(), String> {
        // 使用 mdns 库广播服务
        // 服务名称: "_kabegame-sync._tcp.local"
        // TXT 记录包含设备信息
    }
    
    async fn discover(&self) -> Result<Vec<DiscoveredDevice>, String> {
        // 扫描 mDNS 服务
        // 解析 TXT 记录获取设备信息
    }
}
```

**服务信息格式**：
```
服务名称: "_kabegame-sync._tcp.local"
TXT 记录:
  device_id=xxx
  port=8080
  version=2.1.7
  name=设备名称
```

#### 7.2.2 手动配置发现器

允许用户手动添加设备：

```rust
pub struct ManualDiscoverer {
    devices: Vec<ManualDeviceConfig>,
}

pub struct ManualDeviceConfig {
    pub device_id: String,
    pub device_name: String,
    pub base_url: String,
    pub password: Option<String>,
}
```

#### 7.2.3 局域网扫描发现器（可选）

扫描局域网 IP 段，尝试连接已知端口：

```rust
pub struct LanScanDiscoverer {
    ip_ranges: Vec<IpRange>,
    port: u16,
    timeout: Duration,
}

impl DeviceDiscoverer for LanScanDiscoverer {
    async fn discover(&self) -> Result<Vec<DiscoveredDevice>, String> {
        // 并发扫描 IP 段
        // 尝试连接 /api/status 端点
        // 验证是否为 Kabegame 设备
    }
}
```

#### 7.2.4 UPnP/SSDP 发现器（可选）

使用 UPnP/SSDP 协议发现设备：

```rust
pub struct UpnpDiscoverer {
    service_type: String,
}

impl DeviceDiscoverer for UpnpDiscoverer {
    async fn discover(&self) -> Result<Vec<DiscoveredDevice>, String> {
        // 发送 SSDP M-SEARCH 请求
        // 解析响应获取设备信息
    }
}
```

#### 7.2.5 蓝牙发现器（可选）

通过蓝牙发现设备：

```rust
pub struct BluetoothDiscoverer {
    service_uuid: Uuid,
}

impl DeviceDiscoverer for BluetoothDiscoverer {
    async fn discover(&self) -> Result<Vec<DiscoveredDevice>, String> {
        // 扫描蓝牙设备
        // 检查服务 UUID
        // 获取设备信息
    }
}
```

### 7.3 发现器管理器

```rust
pub struct DiscoveryManager {
    discoverers: Vec<Arc<dyn DeviceDiscoverer>>,
    discovered_devices: Arc<Mutex<HashMap<String, DiscoveredDevice>>>,
}

impl DiscoveryManager {
    /// 注册发现器
    pub fn register_discoverer(&mut self, discoverer: Arc<dyn DeviceDiscoverer>) {
        self.discoverers.push(discoverer);
    }
    
    /// 启动所有启用的发现器
    pub async fn start_all(&self, device: &DeviceInfo) -> Result<(), String> {
        for discoverer in &self.discoverers {
            if discoverer.is_enabled() {
                if let Err(e) = discoverer.start_service(device).await {
                    eprintln!("Failed to start discoverer {}: {}", discoverer.name(), e);
                }
            }
        }
        Ok(())
    }
    
    /// 使用所有发现器发现设备
    pub async fn discover_all(&self) -> Result<Vec<DiscoveredDevice>, String> {
        let mut all_devices = HashMap::new();
        
        // 并发执行所有发现器
        let futures: Vec<_> = self.discoverers.iter()
            .filter(|d| d.is_enabled())
            .map(|d| {
                let discoverer = d.clone();
                tokio::spawn(async move {
                    (discoverer.name(), discoverer.discover().await)
                })
            })
            .collect();
        
        // 收集结果
        for future in futures {
            if let Ok((name, Ok(devices))) = future.await {
                for device in devices {
                    // 去重：相同 device_id 只保留一个
                    all_devices.entry(device.device_id.clone())
                        .or_insert_with(|| device);
                }
            }
        }
        
        Ok(all_devices.into_values().collect())
    }
    
    /// 定期发现（后台任务）
    pub async fn start_periodic_discovery(&self, interval: Duration) {
        loop {
            tokio::time::sleep(interval).await;
            if let Ok(devices) = self.discover_all().await {
                let mut discovered = self.discovered_devices.lock().await;
                for device in devices {
                    discovered.insert(device.device_id.clone(), device);
                }
            }
        }
    }
}
```

### 7.4 发现器配置

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryConfig {
    /// 启用的发现器列表
    pub enabled_discoverers: Vec<String>,
    
    /// 发现器特定配置
    pub discoverer_configs: HashMap<String, serde_json::Value>,
    
    /// 自动发现间隔（秒）
    pub auto_discover_interval: Option<u64>,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            enabled_discoverers: vec!["mDNS".to_string(), "Manual".to_string()],
            discoverer_configs: HashMap::new(),
            auto_discover_interval: Some(30),  // 30 秒
        }
    }
}
```

### 7.5 设备管理

```rust
pub struct DeviceManager {
    discovery_manager: Arc<DiscoveryManager>,
    manual_devices: Arc<Mutex<Vec<ManualDeviceConfig>>>,
    discovered_devices: Arc<Mutex<HashMap<String, DiscoveredDevice>>>,
}

impl DeviceManager {
    /// 添加手动配置的设备
    pub async fn add_manual_device(&self, config: ManualDeviceConfig) {
        self.manual_devices.lock().await.push(config);
    }
    
    /// 获取所有设备（发现的 + 手动配置的）
    pub async fn get_all_devices(&self) -> Vec<DeviceInfo> {
        let mut devices = Vec::new();
        
        // 添加发现的设备
        let discovered = self.discovered_devices.lock().await;
        for device in discovered.values() {
            devices.push(DeviceInfo::from(device));
        }
        
        // 添加手动配置的设备
        let manual = self.manual_devices.lock().await;
        for config in manual.iter() {
            devices.push(DeviceInfo::from(config));
        }
        
        devices
    }
    
    /// 刷新设备列表（触发发现）
    pub async fn refresh(&self) -> Result<(), String> {
        let devices = self.discovery_manager.discover_all().await?;
        let mut discovered = self.discovered_devices.lock().await;
        discovered.clear();
        for device in devices {
            discovered.insert(device.device_id.clone(), device);
        }
        Ok(())
    }
}
```

### 7.6 前端 UI 配置

```vue
<!-- 设备发现设置 -->
<el-card header="设备发现设置">
  <el-form :model="discoveryConfig">
    <!-- 启用的发现器 -->
    <el-form-item label="启用的发现器">
      <el-checkbox-group v-model="discoveryConfig.enabledDiscoverers">
        <el-checkbox label="mDNS">mDNS 自动发现</el-checkbox>
        <el-checkbox label="Manual">手动配置</el-checkbox>
        <el-checkbox label="LanScan">局域网扫描</el-checkbox>
        <el-checkbox label="UPnP">UPnP/SSDP</el-checkbox>
        <el-checkbox label="Bluetooth">蓝牙</el-checkbox>
      </el-checkbox-group>
    </el-form-item>
    
    <!-- 自动发现间隔 -->
    <el-form-item label="自动发现间隔（秒）">
      <el-input-number 
        v-model="discoveryConfig.autoDiscoverInterval"
        :min="10"
        :max="300" />
    </el-form-item>
    
    <!-- 发现器特定配置 -->
    <el-form-item label="局域网扫描配置" v-if="discoveryConfig.enabledDiscoverers.includes('LanScan')">
      <el-input 
        v-model="lanScanConfig.ipRanges"
        placeholder="192.168.1.0/24,192.168.0.0/24" />
    </el-form-item>
  </el-form>
</el-card>
```

### 7.7 优势总结

**可扩展性**：
- 插件化架构，易于添加新的发现方式
- 发现器独立实现，互不干扰
- 可以同时启用多个发现器

**灵活性**：
- 用户可以选择启用的发现器
- 支持手动配置设备
- 可以配置发现器特定参数

**可靠性**：
- 多种发现方式互补
- 自动去重，避免重复设备
- 定期刷新，保持设备列表最新

**性能**：
- 并发执行多个发现器
- 可配置发现间隔
- 缓存发现的设备，减少重复扫描

## 8. 插件脚本使用

### 8.1 插件配置

在插件 `config.json` 中添加 `peer` 类型变量：

```json
{
  "var": [
    {
      "key": "peer_url",
      "type": "peer",
      "name": "选择设备",
      "descripts": "选择要同步的局域网设备"
    }
  ]
}
```

### 8.2 脚本示例

```rhai
// crawl.rhai - 从远程设备同步画册
let base_url = peer_url;

// 获取画册列表
let albums = to_json(base_url + "/api/provider/albums");

// 遍历画册
for album in albums["entries"] {
    if album["type"] == "directory" {
        let album_path = base_url + "/api/provider/albums/" + album["name"];
        let album_detail = to_json(album_path);
        
        // 下载图片
        for entry in album_detail["entries"] {
            if entry["type"] == "file" {
                download_image(base_url + entry["url"]);
            }
        }
    }
}
```

**关键优势**：插件脚本无需修改，自动支持网络设备访问。

## 9. 文件缓存

### 9.1 缓存策略

- 文件下载到本地缓存目录
- 使用设备 ID + 文件 ID 作为缓存键
- 支持 LRU 清理策略
- 虚拟盘直接读取缓存文件

### 9.2 缓存路径

```
{app_data}/network-cache/{device_id}_{file_id}
```

## 10. 实现优先级

### 阶段一：基础框架
1. **HTTP 服务器（axum）**
   - 创建 HTTP 服务器模块
   - 实现基础路由和中间件
   - 集成 IPC 客户端

2. **IPC 请求转换**
   - HTTP 请求 → CliIpcRequest 转换
   - CliIpcResponse → HTTP 响应转换
   - 错误处理和状态码映射

3. **Provider API 端点**
   - `/api/provider` 端点实现
   - 调用 daemon 的 `GalleryBrowseProvider` handler
   - 响应格式转换

4. **基础安全机制**
   - 密码认证中间件
   - 访问控制检查
   - 速率限制

### 阶段二：网络虚拟盘
1. NetworkProvider 实现
2. NetworkGroupProvider 实现
3. RootProvider 扩展
4. 虚拟盘集成测试

### 阶段三：设备发现与管理
1. **设备发现架构**
   - DeviceDiscoverer trait 定义
   - DiscoveryManager 实现
   - mDNS 发现器实现

2. **更多发现器（可选）**
   - 手动配置发现器
   - 局域网扫描发现器
   - UPnP/SSDP 发现器
   - 蓝牙发现器

3. **设备管理器**
   - 设备列表管理
   - 设备状态跟踪
   - 自动刷新机制

4. **前端设备管理 UI**
   - 设备发现设置
   - 设备列表显示
   - 手动添加设备
   - 插件 peer 变量支持

### 阶段四：嵌套访问
1. 转发 API 实现
2. NestedNetworkProvider 实现
3. 循环检测
4. 性能优化

## 11. Daemon 集成

### 11.1 Daemon 职责

Daemon 作为统一的后台服务，处理所有业务逻辑：

- **Storage 操作**：图片、画册、任务的增删改查
- **Provider 解析**：通过 ProviderRuntime 解析路径
- **任务调度**：爬虫任务的执行和管理
- **事件广播**：任务状态、下载进度等事件
- **插件管理**：插件的安装、删除、列表

### 11.2 HTTP 服务器职责

HTTP 服务器作为 daemon 的前端，只负责：

- **协议转换**：HTTP ↔ IPC
- **请求路由**：将 HTTP 路径映射到 IPC 请求
- **响应格式化**：将 IPC 响应转换为 HTTP 响应
- **安全控制**：认证、授权、速率限制

### 11.3 IPC 客户端

HTTP 服务器通过 IPC 客户端与 daemon 通信：

```rust
pub struct IpcClient {
    socket_path: PathBuf,  // Unix Socket 或 Named Pipe
}

impl IpcClient {
    pub async fn request(&self, req: CliIpcRequest) -> Result<CliIpcResponse, String> {
        // 连接到 daemon
        // 发送请求
        // 接收响应
    }
}
```

### 11.4 Daemon 启动 HTTP 服务器

HTTP 服务器作为 daemon 的一部分启动：

```rust
// src-tauri/daemon/src/main.rs
async fn daemon_main() -> Result<(), String> {
    // ... 现有初始化代码 ...
    
    // 启动 HTTP 服务器（作为 daemon 的前端）
    let http_server = Arc::new(HttpServer::new(
        ctx.clone(),  // RequestContext
        settings.clone(),  // 安全设置
    ));
    
    // 在后台任务中启动 HTTP 服务器
    let http_server_clone = http_server.clone();
    tokio::spawn(async move {
        if let Err(e) = http_server_clone.start().await {
            eprintln!("HTTP server error: {}", e);
        }
    });
    
    // 启动 IPC 服务（现有逻辑）
    ipc::serve(move |req| {
        // ... 现有 handler ...
    }).await
}
```

### 11.5 优势总结

**职责集中**：
- Daemon 专注于业务逻辑，不关心传输协议
- HTTP 服务器专注于协议转换，不包含业务逻辑
- 所有业务逻辑集中在 daemon，便于维护

**易于扩展**：
- 可以添加 WebSocket、gRPC 等前端，复用 daemon
- 可以添加新的 IPC handler，自动支持所有前端
- 前端和后端解耦，可以独立演进

**易于测试**：
- HTTP 层和 daemon 层可以独立测试
- 可以 mock IPC 客户端进行单元测试
- 可以测试 HTTP 协议转换逻辑

**统一管理**：
- HTTP 服务器和 IPC 服务器都在 daemon 中管理
- 共享相同的 RequestContext 和资源
- 统一的配置和安全设置

## 11. 技术选型

### 11.1 HTTP 服务器
- **axum**：基于 Tokio，性能好，API 简洁
- **tower**：中间件支持（认证、CORS、日志）

### 11.2 服务发现
- **mdns** 或 **zeroconf**：跨平台 mDNS 支持
- **可选**：UPnP/SSDP 库（如 `upnp-rs`）
- **可选**：蓝牙库（如 `bluer`）

### 11.3 序列化
- **serde_json**：与现有代码一致

## 12. 优势总结

### 12.1 架构优势
- **完全复用**：零侵入扩展，不修改现有 Provider 系统
- **统一抽象**：远程数据与本地数据使用同一接口
- **递归支持**：支持任意深度的嵌套访问

### 12.2 开发优势
- **实现简单**：HTTP 层只做路径转换和序列化
- **易于测试**：各组件可独立测试
- **易于维护**：代码结构清晰，职责分明

### 12.3 用户体验
- **统一体验**：网络设备像本地目录一样浏览
- **透明访问**：嵌套访问对用户透明
- **无缝集成**：虚拟盘、Gallery、插件脚本都自动支持

## 13. 注意事项

### 13.1 性能考虑
- 多层嵌套会增加延迟
- 文件缓存减少重复下载
- 考虑添加并发请求优化

### 13.2 安全考虑
- 默认关闭服务
- 使用强密码
- 定期检查访问日志
- 仅在可信任的局域网使用

### 13.3 错误处理
- 网络故障时的降级策略
- 中间设备故障的处理
- 缓存文件损坏的恢复

## 14. 未来扩展

### 14.1 传输方式
- 蓝牙支持（已讨论）
- WebRTC 支持（P2P）
- 其他传输协议

### 14.2 功能增强
- 增量同步
- 冲突解决
- 同步日志
- 性能监控

### 14.3 安全增强
- TLS/HTTPS 支持
- 密钥交换机制
- 访问审计
- 速率限制优化

---

**文档版本**：v1.0  
**创建日期**：2025-01-15  
**最后更新**：2025-01-15
