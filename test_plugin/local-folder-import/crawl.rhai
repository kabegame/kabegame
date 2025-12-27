// 本地文件夹导入脚本
// 扫描指定文件夹内的图片文件并导入到图库

// 检查文件夹路径是否已设置（使用 try 处理未定义变量）
let folder = "";
try {
    folder = folder_path;
} catch(err) {
    throw "错误：请设置文件夹路径";
}

if folder == "" {
    throw "错误：请设置文件夹路径";
}

// 将文件夹路径转换为标准路径格式
// 注意：前端应该已经处理了路径格式，这里直接使用
// 如果路径被引号包围，Rust 端会处理

// 定义默认的文件扩展名列表
let extensions = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
try {
    let user_extensions = file_extensions;
    if user_extensions.len() > 0 {
        extensions = user_extensions;
    }
} catch(err) {
    // 如果 file_extensions 未定义，使用默认值
}

// 读取文件夹内的文件（非递归）
// 注意：list_local_files 会自动将扩展名转换为小写并添加点号
// 确保 folder 是有效的字符串
if folder == "" {
    throw "错误：文件夹路径为空";
}
// 直接使用 folder 构建 URL
// Rust 端会处理路径格式（包括反斜杠）
// 在 Windows 上，路径可能包含反斜杠，Rust 端会正确处理
let folder_url = "file:///" + folder;
let files = [];
try {
    files = list_local_files(folder_url, extensions);
} catch(err) {
    throw "错误：读取文件夹失败 - " + err;
}

// 计算总文件数
let total_files = files.len();
if total_files == 0 {
    throw "文件夹中没有找到符合条件的文件";
}

// 计算每个文件应该增加的进度：99.9% / 总文件数（留0.1%给完成状态）
let progress_per_file = 99.9 / total_files.to_float();

// 遍历所有文件并调用 download_image
let count = 0;
let file_idx = 0;
while file_idx < total_files {
    let file_path = files[file_idx];
    // download_image 会检测到是本地路径并进行复制
    // download_image 现在直接返回 bool，错误时抛出异常
    try {
        if download_image(file_path) {
            count = count + 1;
        }
    } catch(err) {
        // 下载失败，继续处理下一个文件
    }
    
    // 每处理一个文件，增加相应的进度
    add_progress(progress_per_file);
    
    file_idx = file_idx + 1;
}

// 成功导入完成（不需要打印，任务完成时会自动显示）
