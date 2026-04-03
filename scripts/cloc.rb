#!/usr/bin/env ruby
# frozen_string_literal: true

require 'rbconfig'

# github-linguist → charlock_holmes.so 依赖 ICU 等 DLL。仅改 PATH 有时不够，需登记 DLL 搜索目录（Windows）。
if /mswin|mingw|cygwin/i.match?(RbConfig::CONFIG['host_os'])
  prepend_dll_dirs = lambda do |dirs|
    dirs = dirs.select { |d| File.directory?(d) }
    return if dirs.empty?

    ENV['PATH'] = (dirs + [ENV['PATH']]).compact.join(File::PATH_SEPARATOR)
  end

  begin
    require 'ruby_installer/runtime'
    RubyInstaller::Runtime.enable_dll_search_paths
    inst = RubyInstaller::Runtime.msys2_installation
    prepend_dll_dirs.call([inst.mingw_bin_path, File.join(inst.msys_path, 'usr', 'bin')])
  rescue LoadError
    bindir = RbConfig::CONFIG['bindir']
    ruby_root = File.expand_path('..', bindir)
    candidates = []
    candidates << File.join(ENV['MSYS2_PATH'].to_s, 'ucrt64', 'bin') if ENV['MSYS2_PATH'].to_s != ''
    candidates << File.join(ruby_root, 'msys64', 'ucrt64', 'bin')
    la = ENV['LOCALAPPDATA']
    candidates << File.join(la, 'rubyinstaller', 'msys64', 'ucrt64', 'bin') if la && !la.empty?
    prepend_dll_dirs.call(candidates)
  rescue StandardError
    # MSYS2 未找到或路径异常时，仍尝试 MSYS2_PATH / 常见目录
    bindir = RbConfig::CONFIG['bindir']
    ruby_root = File.expand_path('..', bindir)
    candidates = []
    candidates << File.join(ENV['MSYS2_PATH'].to_s, 'ucrt64', 'bin') if ENV['MSYS2_PATH'].to_s != ''
    candidates << File.join(ruby_root, 'msys64', 'ucrt64', 'bin')
    la = ENV['LOCALAPPDATA']
    candidates << File.join(la, 'rubyinstaller', 'msys64', 'ucrt64', 'bin') if la && !la.empty?
    prepend_dll_dirs.call(candidates)
  end
end

require 'linguist'
require 'optparse'
require 'json'
require 'open3'
require 'tmpdir'

# 默认配置
DEFAULT_PATH = '.'
DEFAULT_EXCLUDE = 'node_modules,dist,build,.git,target,.nx,public,data,release,photoswipe-vue/src/js,third,ignore'
DEFAULT_INCLUDE_EXT = 'ts,tsx,js,mjs,vue,rs,py,java,kt,swift,cs,cpp,c,cmake,h,cc,hpp,rb,html,css,scss,rhai,kt,kts,handlebars,prisma,Dockerfile,sh,ejs'

# Linguist 未支持的语言在此指定颜色（hex，如 #F67702）
CUSTOM_LANG_COLORS = { 'Rhai' => '#F67702' }.freeze

def usage
  puts <<~USAGE
    用法:
      ruby scripts/cloc.rb
      ruby scripts/cloc.rb --path <路径> --exclude <逗号分隔目录> --include-ext <逗号分隔后缀>

    示例:
      ruby scripts/cloc.rb                                    # 默认显示图形界面
      ruby scripts/cloc.rb --path src-tauri                   # 统计指定路径
      ruby scripts/cloc.rb --exclude "node_modules,dist"      # 排除指定目录
      ruby scripts/cloc.rb --include-ext "rs,ts,tsx,vue"      # 只统计指定扩展名
      ruby scripts/cloc.rb --no-gui                           # 仅输出到终端
      ruby scripts/cloc.rb --console                          # 同时输出到终端和图形界面

    选项:
      -h, --help              显示帮助信息
      -p, --path PATH         指定要统计的路径（默认: .）
      -e, --exclude DIRS      排除的目录，逗号分隔
      --include-ext EXTS      包含的文件扩展名，逗号分隔
      --no-gui                不显示图形界面，仅输出到终端
      --console               同时输出到终端和图形界面

    注意: 需要安装 github-linguist gem:
      gem install github-linguist
    Windows: 若 charlock_holmes 报 LoadError 126，请确认已安装 MSYS2 UCRT64 与 ICU；可设置环境变量 MSYS2_PATH
      指向 MSYS2 根目录（含 usr\\bin\\msys-2.0.dll），或把 …\\ucrt64\\bin 加入系统 PATH。
  USAGE
end

def parse_args
  options = {
    path: DEFAULT_PATH,
    exclude: DEFAULT_EXCLUDE,
    include_ext: DEFAULT_INCLUDE_EXT,
    gui: true,
    console: false
  }

  OptionParser.new do |opts|
    opts.banner = '用法: ruby scripts/cloc.rb [选项]'

    opts.on('-h', '--help', '显示帮助信息') do
      usage
      exit 0
    end

    opts.on('-p', '--path PATH', '指定要统计的路径（默认: .）') do |path|
      options[:path] = path
    end

    opts.on('-e', '--exclude DIRS', "排除的目录，逗号分隔（默认: #{DEFAULT_EXCLUDE}）") do |dirs|
      options[:exclude] = dirs
    end

    opts.on('--include-ext EXTS', "包含的文件扩展名，逗号分隔（默认: #{DEFAULT_INCLUDE_EXT}）") do |exts|
      options[:include_ext] = exts
    end

    opts.on('--no-gui', '不显示图形界面，仅输出到终端') do
      options[:gui] = false
      options[:console] = true
    end

    opts.on('--console', '同时输出到终端和图形界面') do
      options[:console] = true
    end
  end.parse!

  options
end

def should_exclude?(file_path, exclude_dirs)
  # 将路径标准化（处理相对路径和绝对路径）
  normalized_path = file_path.gsub(/^\.\//, '')
  
  exclude_dirs.any? do |dir|
    # 匹配目录名（如 dist/ 或 dist-main/）
    # 使用路径分隔符确保精确匹配目录，而不是文件名中的字符串
    # 支持匹配 dist 和 dist-* 这样的模式
    pattern = /(^|\/)#{Regexp.escape(dir)}(-|\/|$)/
    normalized_path.match?(pattern)
  end
end

def should_include?(file_path, include_exts)
  return true if include_exts.empty?

  # 始终包含 CMakeLists.txt（扩展名为 .txt 会漏掉）
  return true if File.basename(file_path) == 'CMakeLists.txt'

  ext = File.extname(file_path).sub(/^\./, '')
  include_exts.include?(ext)
end

def count_lines(file_path, _language)
  return { total: 0, code: 0, comment: 0, blank: 0 } unless File.file?(file_path)

  begin
    content = File.read(file_path, encoding: 'UTF-8')
    lines = content.split(/\r?\n/)
    total = lines.length
    blank = lines.count { |l| l.strip.empty? }
    comment = 0

    # 根据语言类型检测注释
    in_block_comment = false
    lines.each do |line|
      stripped = line.strip

      # 块注释检测
      if in_block_comment
        comment += 1
        in_block_comment = false if stripped.include?('*/') || stripped.end_with?('*/')
        next
      end

      # 单行注释检测
      if stripped.start_with?('#') ||
         stripped.start_with?('//') ||
         stripped.start_with?('--') ||
         stripped.match?(/^\s*\*\s/) ||
         stripped.start_with?('/*')
        comment += 1
        in_block_comment = true if stripped.start_with?('/*') && !stripped.include?('*/')
      end
    end

    code = total - blank - comment
    { total: total, code: [code, 0].max, comment: comment, blank: blank }
  rescue StandardError
    { total: 0, code: 0, comment: 0, blank: 0 }
  end
end

def scan_directory(dir_path, exclude_dirs, include_exts, stats, counters)
  # 将路径转换为绝对路径，用于 FileBlob
  abs_dir_path = File.expand_path(dir_path)
  
  Dir.glob(File.join(dir_path, '**', '*')).each do |file_path|
    next if should_exclude?(file_path, exclude_dirs)
    next unless File.file?(file_path)
    next unless should_include?(file_path, include_exts)

    begin
      abs_file_path = File.expand_path(file_path)
      blob = Linguist::FileBlob.new(abs_file_path, abs_dir_path)
      language = Linguist.detect(blob)
      ext = File.extname(file_path).downcase.delete('.')
      if ext == 'rhai' && (language.nil? || language.name != 'Rhai')
        lang_name = 'Rhai'
      else
        next unless language
        lang_name = language.name
      end
      stats[lang_name] ||= { files: 0, lines: 0, code: 0, comment: 0, blank: 0 }

      line_counts = count_lines(file_path, language)
      stats[lang_name][:files] += 1
      stats[lang_name][:lines] += line_counts[:total]
      stats[lang_name][:code] += line_counts[:code]
      stats[lang_name][:comment] += line_counts[:comment]
      stats[lang_name][:blank] += line_counts[:blank]

      counters[:files] += 1
      counters[:lines] += line_counts[:total]
      counters[:code] += line_counts[:code]
      counters[:comment] += line_counts[:comment]
      counters[:blank] += line_counts[:blank]
    rescue StandardError => e
      # 忽略无法处理的文件
      puts "警告: 无法处理文件 #{file_path}: #{e.message}" if ENV['DEBUG']
    end
  end
end

def template_path
  File.join(File.dirname(File.expand_path(__FILE__)), 'cloc_report.html')
end

def load_html_template
  path = template_path
  raise "模板文件不存在: #{path}" unless File.file?(path)

  File.read(path, encoding: 'UTF-8')
end

def generate_html(stats, counters, path)
  sorted_stats = stats.sort_by { |_, v| -v[:lines] }
  total_lines = counters[:lines]

  # 生成饼图数据（按总行数）
  chart_data = sorted_stats.map do |lang, data|
    percentage = total_lines > 0 ? (data[:lines].to_f / total_lines * 100).round(2) : 0
    {
      label: lang,
      value: data[:lines],
      percentage: percentage,
      files: data[:files],
      lines: data[:lines],
      code: data[:code],
      comment: data[:comment],
      blank: data[:blank]
    }
  end

  # 使用 GitHub Linguist 定义的语言官方颜色，未支持的语言使用 CUSTOM_LANG_COLORS
  colors = []
  sorted_stats.each_with_index do |(lang_name, _), i|
    color = CUSTOM_LANG_COLORS[lang_name]
    unless color
      lang_obj = Linguist::Language[lang_name] || Linguist::Language.find_by_name(lang_name)
      color = lang_obj&.color
    end
    if color
      # Linguist 返回 hex 如 #3178c6，确保有 # 前缀
      colors << (color.start_with?('#') ? color : "##{color}")
    else
      # 无定义颜色时使用 HSL 备用
      hue = (i * 137.508) % 360
      colors << "hsl(#{hue}, 70%, 60%)"
    end
  end

  summary = "总计: #{counters[:files]} 个文件, #{counters[:lines]} 行 (代码: #{counters[:code]}, 注释: #{counters[:comment]}, 空行: #{counters[:blank]})"

  html = load_html_template
  expanded_scan_path = File.expand_path(path)
  # 页面上展示：Windows 用反斜杠，与其它平台用 expand_path 默认形态一致
  path_display = if /mswin|mingw|cygwin/i.match?(RbConfig::CONFIG['host_os'])
    expanded_scan_path.tr('/', '\\')
  else
    expanded_scan_path
  end

  html
    .gsub('__PATH__', path_display)
    .gsub('__SUMMARY__', summary)
    .gsub('__CHART_DATA_JSON__', chart_data.to_json)
    .gsub('__COLORS_JSON__', colors.to_json)
end

def open_browser(file_path)
  fp = File.expand_path(file_path)
  host = RbConfig::CONFIG['host_os']
  case host
  when /darwin/
    system('open', fp)
  when /linux/
    system('xdg-open', fp)
  when /mswin|mingw|cygwin/
    # cmd 的 start：第一个引号参数是「窗口标题」，必须用 start "" "路径"，不能 start "路径"
    fp_win = fp.tr('/', '\\')
    system('cmd', '/c', 'start', '', fp_win)
  else
    puts "无法自动打开浏览器，请手动打开: #{fp}"
  end
end

# 主程序
begin
  options = parse_args

  exclude_dirs = options[:exclude].split(',').map(&:strip)
  include_exts = options[:include_ext].split(',').map(&:strip)

  stats = {}
  counters = { files: 0, lines: 0, code: 0, comment: 0, blank: 0 }

  puts "正在扫描目录: #{options[:path]}..." if options[:console] || !options[:gui]
  scan_directory(options[:path], exclude_dirs, include_exts, stats, counters)

  # 输出到终端（如果启用）
  if options[:console] || !options[:gui]
    puts '      Language                     Files          Lines        Code     Comment       Blank'
    puts '--------------------------------------------------------------------------------------------'
    sorted_stats = stats.sort_by { |_, v| -v[:lines] }
    sorted_stats.each do |lang, data|
      printf("%-30s %8d %12d %10d %10d %10d\n",
             lang, data[:files], data[:lines], data[:code], data[:comment], data[:blank])
    end
    puts '--------------------------------------------------------------------------------------------'
    printf("%-30s %8d %12d %10d %10d %10d\n",
           'SUM', counters[:files], counters[:lines], counters[:code], counters[:comment], counters[:blank])
  end

  # 生成并打开 HTML 报告（如果启用 GUI）
  if options[:gui]
    html_content = generate_html(stats, counters, File.expand_path(options[:path]))
    html_file = File.join(Dir.tmpdir, "cloc_report_#{Time.now.to_i}.html")
    File.write(html_file, html_content)
    puts "报告已生成: #{html_file}" if options[:console]
    open_browser(html_file)
  end
rescue OptionParser::InvalidOption => e
  puts "错误: #{e.message}"
  usage
  exit 2
rescue StandardError => e
  puts "错误: #{e.message}"
  puts e.backtrace if ENV['DEBUG']
  exit 1
end
