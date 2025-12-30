# 统计仓库源码行数的便捷脚本
# 用法：在仓库根目录执行
#   pwsh scripts/cloc.ps1
# 可选参数：
#   -Path <路径>        要统计的目录，默认当前目录
#   -Exclude <列表>     逗号分隔的排除目录，默认 "node_modules,dist,build,.git,.turbo,.next"

param(
    [string]$Path = ".",
    [string]$Exclude = "node_modules,dist,build,.git,.turbo,.next,target,.nx,public,",
    # 仅统计指定后缀，防止将 json 等非代码文件计入。逗号分隔。
    [string]$IncludeExt = "ts,tsx,js,jsx,vue,rs,go,py,java,kt,swift,cs,cpp,c,h,cc,hpp,rb,php,html,css,scss,rhai"
)

function Invoke-Cloc {
    param(
        [string]$Target,
        [string]$ExcludeDirs,
        [string]$Include
    )

    $excludeArg = "--exclude-dir=" + $ExcludeDirs
    $includeArg = "--include-ext=" + $Include

    if (Get-Command cloc -ErrorAction SilentlyContinue) {
        cloc $Target $excludeArg $includeArg
        return
    }

    if (Get-Command npx -ErrorAction SilentlyContinue) {
        # 使用 npx 运行，无需全局安装
        npx --yes cloc $Target $excludeArg $includeArg
        return
    }
}

Invoke-Cloc -Target $Path -ExcludeDirs $Exclude -Include $IncludeExt


