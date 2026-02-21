架构发生了调整，FolderPickerPlugin被移到了 @kabegame/src-tauri-plugins/tauri-plugin-picker/android/src/main/java/PickerPlugin.kt  ，我将详细描述我的需求：
在安卓下，用户不会把文件和文件夹混着选，这是 @kabegame/apps/main/src/components/MediaPicker.vue 限制的。并且只会选择一个文件夹。
在安卓下，自动递归文件夹，并不递归文件夹的压缩包。因此在安卓下要带上正确的参数调用本地导入。
本地导入流程为，处理path改成处理uri，传入url::Url类型参数，其scheme为当安卓的时候一定为content，当桌面的时候一定为 file。并在桌面上调用的时候用路径转file uri的函数调用process_path，否则无法传参。在桌面上，把file uri转变成路径后用现有metadata处理，而在安卓上，则用picker插件来获取一个tree uri 之下一级的所有uri，返回给rust。添加 isDirectory 调用，传入url，内部用ContentResolver.query() 返回是否是文件夹，rust在安卓上用这个接口来判断是否是目录。在安卓上的 is_image_by_path通过调用新的接口（需添加）来查询 val mimeType = contentResolver.getType(uri)，不通过后缀名。
在download_worker侧，拿到的会是一个content uri，这时候将uri的download函数用 ```try {
    contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
    )
} catch (e: SecurityException) {
    // 不支持持久授权，忽略即可
} ``` 请求授权（给插件添加一个新的授权接口），请求授权失败。 @kabegame/src-tauri/core/src/crawler/downloader/content.rs 的 compute_destination_path是错误的，目标path还是原uri，但是实际上不需要复制也不关心这个字段。 handle_content则是调用授权api获得持久授权，这样下次应用启动就可以查看用户以前导入的图片。
在下载的后处理阶段要读取图片，这时候就需要一个读取content uri的api。并根据结果来计算后续操作。
如果用户选择了“选择图片”，则插件会调用Jetpack的ActivityResultContracts.PickVisualMedia()来快捷拉起媒体选择器，可以多选。并在之后对图片列表会自动做 process_path -> process_file 处理。
对于选择压缩文件，压缩文件不用解压，而是采用遍历entry，然后将遍历到的图片（采用后缀名判断）通过MediaStore保留原压缩包子文件夹结构地添加到该压缩文件对应的子文件夹中（与现有桌面逻辑的区别在于，现有逻辑直接解压所有文件），用后缀小 "(num)" 括号加数字的形式避免重名，此避免重名的逻辑在桌面也要做，目前没做。然后在 ArchiveProcessor的process返回会得到uri而非path了，在解压缩worker那里会按照现有桌面逻辑来扫描输出的文件夹。这里有很多必要的io接口需要添加到kotlin插件中，尽量用抽象通用的接口，不要具象多杂。
对于前端展示，原图通过图片的content uri而非本地路径，缩略图还是保存在外部存储的数据文件夹下，因此要在pathes插件里面给出