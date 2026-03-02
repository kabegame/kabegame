#!/usr/bin/env ruby
# frozen_string_literal: true

require 'linguist'
require 'optparse'
require 'json'
require 'open3'
require 'rbconfig'
require 'tmpdir'

# 默认配置
DEFAULT_PATH = '.'
DEFAULT_EXCLUDE = 'node_modules,dist,build,.git,target,.nx,public,data,release,photoswipe-vue/src/js'
DEFAULT_INCLUDE_EXT = 'ts,tsx,js,mjs,vue,rs,py,java,kt,swift,cs,cpp,c,h,cc,hpp,rb,html,css,scss,rhai,kt,kts,handlebars,prisma'

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
      next unless language

      lang_name = language.name
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
  
  # 使用 GitHub Linguist 定义的语言官方颜色
  colors = []
  sorted_stats.each_with_index do |(lang_name, _), i|
    lang_obj = Linguist::Language[lang_name] || Linguist::Language.find_by_name(lang_name)
    color = lang_obj&.color
    if color
      # Linguist 返回 hex 如 #3178c6，确保有 # 前缀
      colors << (color.start_with?('#') ? color : "##{color}")
    else
      # 无定义颜色时使用 HSL 备用
      hue = (i * 137.508) % 360
      colors << "hsl(#{hue}, 70%, 60%)"
    end
  end
  
  html = <<~HTML
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>代码统计 - CLOC</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
          background: white;
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          padding: 30px;
        }
        
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 28px;
        }
        
        .path-info {
          color: #666;
          margin-bottom: 30px;
          font-size: 14px;
        }
        
        .stats-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 30px;
          margin-bottom: 30px;
        }
        
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }
        }
        
        .chart-container {
          position: relative;
          height: 500px;
          background: #f8f9fa;
          border-radius: 12px;
          padding: 20px;
        }
        
        .table-container {
          background: #f8f9fa;
          border-radius: 12px;
          padding: 20px;
          overflow-x: auto;
        }
        
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }
        
        thead {
          background: #667eea;
          color: white;
        }
        
        th, td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #e0e0e0;
        }
        
        th {
          font-weight: 600;
          position: sticky;
          top: 0;
        }
        
        tbody tr:hover {
          background: #f0f0f0;
        }
        
        .summary {
          margin-top: 20px;
          padding: 15px;
          background: #667eea;
          color: white;
          border-radius: 8px;
          font-weight: 600;
        }
        
        .tooltip {
          position: absolute;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 13px;
          pointer-events: none;
          z-index: 1000;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          display: none;
          max-width: 300px;
        }
        
        .tooltip.show {
          display: block;
        }
        
        .tooltip-title {
          font-weight: 600;
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .tooltip-item {
          margin: 4px 0;
          display: flex;
          justify-content: space-between;
        }
        
        .legend {
          display: flex;
          flex-wrap: wrap;
          gap: 15px;
          margin-top: 20px;
          padding: 15px;
          background: #f8f9fa;
          border-radius: 8px;
        }
        
        .legend-item {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
        }
        
        .legend-color {
          width: 16px;
          height: 16px;
          border-radius: 4px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📊 代码统计报告</h1>
        <div class="path-info">统计路径: #{path}</div>
        
        <div class="stats-grid">
          <div class="chart-container">
            <canvas id="pieChart"></canvas>
            <div id="tooltip" class="tooltip"></div>
          </div>
          
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>语言</th>
                  <th>文件数</th>
                  <th>总行数</th>
                  <th>代码行</th>
                  <th>注释行</th>
                  <th>空行</th>
                </tr>
              </thead>
              <tbody id="tableBody">
              </tbody>
            </table>
            <div class="summary">
              总计: #{counters[:files]} 个文件, #{counters[:lines]} 行 (代码: #{counters[:code]}, 注释: #{counters[:comment]}, 空行: #{counters[:blank]})
            </div>
          </div>
        </div>
      </div>
      
      <script>
        const chartData = #{chart_data.to_json};
        const colors = #{colors.to_json};
        
        const ctx = document.getElementById('pieChart').getContext('2d');
        const tooltip = document.getElementById('tooltip');
        
        const chart = new Chart(ctx, {
          type: 'pie',
          data: {
            labels: chartData.map(d => d.label),
            datasets: [{
              data: chartData.map(d => d.value),
              backgroundColor: colors,
              borderColor: '#fff',
              borderWidth: 2,
              hoverBorderWidth: 3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  padding: 15,
                  font: {
                    size: 12
                  },
                  generateLabels: function(chart) {
                    const data = chart.data;
                    if (data.labels.length && data.datasets.length) {
                      return data.labels.map((label, i) => {
                        const dataset = data.datasets[0];
                        const value = dataset.data[i];
                        const total = dataset.data.reduce((a, b) => a + b, 0);
                        const percentage = ((value / total) * 100).toFixed(2);
                        return {
                          text: label + ' (' + percentage + '%)',
                          fillStyle: dataset.backgroundColor[i],
                          strokeStyle: dataset.borderColor,
                          lineWidth: dataset.borderWidth,
                          hidden: false,
                          index: i
                        };
                      });
                    }
                    return [];
                  }
                }
              },
              tooltip: {
                enabled: false,
                external: function(context) {
                  const tooltipModel = context.tooltip;
                  if (tooltipModel.opacity === 0) {
                    tooltip.style.display = 'none';
                    return;
                  }
                  
                  const dataIndex = tooltipModel.dataPoints[0].dataIndex;
                  const data = chartData[dataIndex];
                  
                  tooltip.innerHTML = 
                    '<div class="tooltip-title">' + data.label + '</div>' +
                    '<div class="tooltip-item"><span>代码行数:</span><span>' + data.code.toLocaleString() + '</span></div>' +
                    '<div class="tooltip-item"><span>占比:</span><span>' + data.percentage + '%</span></div>' +
                    '<div class="tooltip-item"><span>文件数:</span><span>' + data.files.toLocaleString() + '</span></div>' +
                    '<div class="tooltip-item"><span>总行数:</span><span>' + data.lines.toLocaleString() + '</span></div>' +
                    '<div class="tooltip-item"><span>注释行:</span><span>' + data.comment.toLocaleString() + '</span></div>' +
                    '<div class="tooltip-item"><span>空行:</span><span>' + data.blank.toLocaleString() + '</span></div>';
                  
                  const position = context.chart.canvas.getBoundingClientRect();
                  tooltip.style.left = position.left + tooltipModel.caretX + 'px';
                  tooltip.style.top = position.top + tooltipModel.caretY + 'px';
                  tooltip.style.display = 'block';
                  tooltip.classList.add('show');
                }
              }
            },
            onHover: function(event, activeElements) {
              event.native.target.style.cursor = activeElements.length > 0 ? 'pointer' : 'default';
            }
          }
        });
        
        // 填充表格
        const tableBody = document.getElementById('tableBody');
        chartData.forEach((data, index) => {
          const row = document.createElement('tr');
          row.style.cursor = 'pointer';
          row.onmouseenter = function() {
            this.style.background = '#e3f2fd';
          };
          row.onmouseleave = function() {
            this.style.background = '';
          };
          row.onclick = function() {
            chart.setActiveElements([{datasetIndex: 0, index: index}]);
            chart.update();
          };
          row.innerHTML = 
            '<td><span style="display: inline-block; width: 12px; height: 12px; background: ' + colors[index] + '; border-radius: 2px; margin-right: 8px;"></span>' + data.label + '</td>' +
            '<td>' + data.files.toLocaleString() + '</td>' +
            '<td>' + data.lines.toLocaleString() + '</td>' +
            '<td><strong>' + data.code.toLocaleString() + '</strong></td>' +
            '<td>' + data.comment.toLocaleString() + '</td>' +
            '<td>' + data.blank.toLocaleString() + '</td>';
          tableBody.appendChild(row);
        });
      </script>
    </body>
    </html>
  HTML
  
  html
end

def open_browser(file_path)
  case RbConfig::CONFIG['host_os']
  when /darwin/
    system("open '#{file_path}'")
  when /linux/
    system("xdg-open '#{file_path}'")
  when /mswin|mingw|cygwin/
    system("start '#{file_path}'")
  else
    puts "无法自动打开浏览器，请手动打开: #{file_path}"
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
