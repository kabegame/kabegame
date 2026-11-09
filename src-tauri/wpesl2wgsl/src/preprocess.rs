//! WPESL 预处理：块注释剥离、行续接、`#include` 展开、条件编译求值，以及注释元数据（`// [COMBO]`、
//! uniform 行尾 JSON）的提取。
//!
//! 只求值条件分支、只记录对象宏用于 `#if`；`#define` / `#undef` 行原样保留，函数宏与正文里的宏展开
//! 交给 naga 自带的预处理器。未定义的标识符在 `#if` 里按 0 处理（与 C 预处理器、WPE 在 Windows 上走的
//! D3DCompile 一致：大量 COMBO 不写 `// [COMBO]` 声明，直接 `#if MULTI`）。

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::library::{self, Expansion};

/// include 嵌套上限，防止自包含或深链。
const MAX_INCLUDE_DEPTH: usize = 32;
/// `#if` 里宏展开的递归上限。
const MAX_EXPAND_DEPTH: usize = 32;

/// 一行有效代码：已去掉注释与预处理条件，`comment` 是同一行 `//` 之后的文字（元数据在这里）。
#[derive(Debug, Clone)]
pub struct Line {
    pub code: String,
    pub comment: Option<String>,
    pub file: String,
    pub line: u32,
}

/// 预处理诊断（文件名为 include 名，主源码为 `<vertex>` / `<fragment>`）。
#[derive(Debug, Clone)]
pub struct PreprocessError {
    pub message: String,
    pub file: String,
    pub line: u32,
}

/// `#define` 记录：对象宏保存替换文本供 `#if` 求值；函数宏只记名字（`defined()` 用）。
#[derive(Debug, Clone)]
pub enum Macro {
    Object(String),
    Function,
}

/// 预处理器状态：宏表随处理推进；`includes` 是调用方提供的头文件源码（按 `#include` 里的名字）。
pub struct Preprocessor<'a> {
    includes: &'a BTreeMap<String, String>,
    macros: BTreeMap<String, Macro>,
    pub lines: Vec<Line>,
    /// 处于有效分支、但调用方没提供的头文件。
    pub missing: BTreeSet<String>,
    /// 处于有效分支、`library` 展开不了的 `#require`。`LIGHTING` 关闭时的 `LightingV1` 不算，它展开成空。
    pub requires: BTreeSet<String>,
    /// 实际展开过的头文件（含嵌套）。几何着色器展开时，几何段据此跳过顶点段已经展开过的头文件。
    pub expanded: BTreeSet<String>,
    /// 只求宏、不出行的头文件（[`Preprocessor::skip_includes`]）。
    skip: BTreeSet<String>,
    /// 正在静默处理的头文件层数：大于 0 时不产出行。
    silent: usize,
}

#[derive(Debug, Clone, Copy)]
struct Cond {
    /// 外层是否有效。
    parent_active: bool,
    /// 当前分支是否有效。
    active: bool,
    /// 本组是否已有分支命中（命中后 `#elif` / `#else` 都无效）。
    taken: bool,
}

impl<'a> Preprocessor<'a> {
    /// `defines` 是初始宏表（平台宏、COMBO、纹理格式），值按对象宏处理。
    pub fn new(includes: &'a BTreeMap<String, String>, defines: &BTreeMap<String, String>) -> Self {
        Self {
            includes,
            macros: defines
                .iter()
                .map(|(name, value)| (name.clone(), Macro::Object(value.clone())))
                .collect(),
            lines: Vec::new(),
            missing: BTreeSet::new(),
            requires: BTreeSet::new(),
            expanded: BTreeSet::new(),
            skip: BTreeSet::new(),
            silent: 0,
        }
    }

    /// 这些头文件已在拼接后的源码前面展开过（几何段跳过顶点段的头文件）：照常处理，让其中的 `#define`
    /// 进宏表、驱动本段的 `#if`，但不产出任何行。WPE 的头文件（如 `common_particles.h`）没有头文件保护，
    /// 原样再展开一次会重复定义函数与 uniform。
    pub fn skip_includes(&mut self, names: BTreeSet<String>) {
        self.skip = names;
    }

    pub fn run(&mut self, file: &str, source: &str) -> Result<(), PreprocessError> {
        self.process(file, source, 0)
    }

    fn process(&mut self, file: &str, source: &str, depth: usize) -> Result<(), PreprocessError> {
        if depth > MAX_INCLUDE_DEPTH {
            return Err(error(file, 0, "include 嵌套过深（可能自包含）"));
        }
        let stripped = strip_block_comments(source);
        let mut stack: Vec<Cond> = Vec::new();
        for (line_no, raw) in logical_lines(&stripped) {
            let (code, comment) = split_line_comment(&raw);
            let active = stack.last().is_none_or(|cond| cond.active);
            let trimmed = code.trim_start();
            if let Some(directive) = trimmed.strip_prefix('#') {
                let directive = directive.trim_start();
                let (name, rest) = split_ident(directive);
                let rest = rest.trim();
                let fail = |message: String| error(file, line_no, &message);
                match name {
                    "if" | "ifdef" | "ifndef" => {
                        let value = if active {
                            match name {
                                "if" => self.eval(rest).map_err(fail)? != 0,
                                "ifdef" => self.macros.contains_key(split_ident(rest).0),
                                _ => !self.macros.contains_key(split_ident(rest).0),
                            }
                        } else {
                            false
                        };
                        stack.push(Cond {
                            parent_active: active,
                            active: value,
                            taken: value || !active,
                        });
                    }
                    "elif" => {
                        let Some(cond) = stack.last_mut() else {
                            return Err(fail("#elif 没有对应的 #if".into()));
                        };
                        if !cond.parent_active || cond.taken {
                            cond.active = false;
                        } else {
                            let value = self.eval(rest).map_err(fail)? != 0;
                            let cond = stack.last_mut().expect("checked above");
                            cond.active = value;
                            cond.taken = value;
                        }
                    }
                    "else" => {
                        let Some(cond) = stack.last_mut() else {
                            return Err(fail("#else 没有对应的 #if".into()));
                        };
                        cond.active = cond.parent_active && !cond.taken;
                        cond.taken = true;
                    }
                    "endif" => {
                        if stack.pop().is_none() {
                            return Err(fail("#endif 没有对应的 #if".into()));
                        }
                    }
                    _ if !active => {}
                    "include" => {
                        let Some(target) = include_target(rest) else {
                            return Err(fail(format!("无法解析 #include {rest}")));
                        };
                        match self.includes.get(target) {
                            Some(included) => {
                                let included = included.clone();
                                let silent = self.skip.contains(target);
                                if silent {
                                    self.silent += 1;
                                } else if self.silent == 0 {
                                    self.expanded.insert(target.to_string());
                                }
                                let result = self.process(target, &included, depth + 1);
                                if silent {
                                    self.silent -= 1;
                                }
                                result?;
                            }
                            None => {
                                self.missing.insert(target.to_string());
                            }
                        }
                    }
                    "define" => {
                        let (macro_name, after) = split_ident(rest);
                        if macro_name.is_empty() {
                            return Err(fail("#define 缺少宏名".into()));
                        }
                        let entry = if after.starts_with('(') {
                            Macro::Function
                        } else {
                            Macro::Object(after.trim().to_string())
                        };
                        self.macros.insert(macro_name.to_string(), entry);
                        self.push(code, None, file, line_no);
                    }
                    "undef" => {
                        self.macros.remove(split_ident(rest).0);
                        self.push(code, None, file, line_no);
                    }
                    "require" => {
                        match library::expand(rest, |name| self.eval(name)).map_err(fail)? {
                            Expansion::Nothing => {}
                            Expansion::Source(source) => {
                                self.process(&format!("<{rest}>"), &source, depth + 1)?;
                            }
                            Expansion::Unsupported(what) => {
                                self.requires.insert(what);
                            }
                        }
                    }
                    // 版本 / 扩展由翻译器统一给出（GLSL 450），源码里的去掉
                    "version" | "extension" | "pragma" | "line" | "" => {}
                    other => return Err(fail(format!("不支持的预处理指令 #{other}"))),
                }
                continue;
            }
            if active {
                let code = self
                    .resolve_array_sizes(&code)
                    .map_err(|message| error(file, line_no, &message))?;
                self.push(code, comment, file, line_no);
            }
        }
        if !stack.is_empty() {
            return Err(error(file, 0, "#if 没有闭合"));
        }
        Ok(())
    }

    fn push(&mut self, code: String, comment: Option<String>, file: &str, line: u32) {
        if self.silent > 0 {
            return;
        }
        self.lines.push(Line {
            code,
            comment,
            file: file.to_string(),
            line,
        });
    }

    /// 全局声明的数组长度可能写成宏（如 `g_Bones[BONECOUNT]`）：这里按当前宏表求出数字。
    /// uniform 之后会被挪到源码最前面的 uniform 块里，那时宏可能还没定义。
    fn resolve_array_sizes(&self, code: &str) -> Result<String, String> {
        let trimmed = code.trim_start();
        let is_global_decl = ["uniform", "attribute", "varying"]
            .iter()
            .any(|keyword| split_ident(trimmed).0 == *keyword);
        if !is_global_decl || !code.contains('[') {
            return Ok(code.to_string());
        }
        let mut out = String::with_capacity(code.len());
        let mut rest = code;
        while let Some(open) = rest.find('[') {
            let Some(close) = rest[open..].find(']') else {
                break;
            };
            let inner = &rest[open + 1..open + close];
            out.push_str(&rest[..=open]);
            if inner.trim().chars().all(|c| c.is_ascii_digit()) {
                out.push_str(inner);
            } else {
                out.push_str(&self.eval(inner)?.to_string());
            }
            out.push(']');
            rest = &rest[open + close + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    /// 求值 `#if` / `#elif` 表达式（整数语义）。
    pub fn eval(&self, expr: &str) -> Result<i64, String> {
        let tokens = tokenize(expr)?;
        let mut expanding = HashSet::new();
        let tokens = self.expand(&tokens, &mut expanding, 0)?;
        let mut parser = ExprParser {
            tokens: &tokens,
            pos: 0,
        };
        let value = parser.ternary()?;
        if parser.pos != tokens.len() {
            return Err(format!("#if 表达式多余的内容：{expr}"));
        }
        Ok(value)
    }

    fn expand(
        &self,
        tokens: &[Tok],
        expanding: &mut HashSet<String>,
        depth: usize,
    ) -> Result<Vec<Tok>, String> {
        if depth > MAX_EXPAND_DEPTH {
            return Err("#if 宏展开过深".into());
        }
        let mut out = Vec::with_capacity(tokens.len());
        let mut i = 0;
        while i < tokens.len() {
            match &tokens[i] {
                Tok::Ident(name) if name == "defined" => {
                    // defined X 或 defined(X)：在宏展开之前判定
                    let (target, next) =
                        match (tokens.get(i + 1), tokens.get(i + 2), tokens.get(i + 3)) {
                            (Some(Tok::Op("(")), Some(Tok::Ident(target)), Some(Tok::Op(")"))) => {
                                (target, i + 4)
                            }
                            (Some(Tok::Ident(target)), _, _) => (target, i + 2),
                            _ => return Err("defined 后缺少宏名".into()),
                        };
                    out.push(Tok::Num(i64::from(self.macros.contains_key(target))));
                    i = next;
                    continue;
                }
                Tok::Ident(name) => match self.macros.get(name) {
                    Some(Macro::Object(value)) if !expanding.contains(name) => {
                        expanding.insert(name.clone());
                        let inner = tokenize(value)?;
                        out.extend(self.expand(&inner, expanding, depth + 1)?);
                        expanding.remove(name);
                    }
                    Some(Macro::Function) => return Err(format!("#if 里不支持函数宏 {name}")),
                    // 未定义（或自引用）的标识符按 0
                    _ => out.push(Tok::Num(0)),
                },
                other => out.push(other.clone()),
            }
            i += 1;
        }
        Ok(out)
    }
}

fn error(file: &str, line: u32, message: &str) -> PreprocessError {
    PreprocessError {
        message: message.to_string(),
        file: file.to_string(),
        line,
    }
}

/// 去掉 `/* */`（保留其中的换行，行号不变）；行注释原样保留，元数据在里面。
pub fn strip_block_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut in_line_comment = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_line_comment {
            if c == b'\n' {
                in_line_comment = false;
            }
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            in_line_comment = true;
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                if bytes[i] == b'\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
            out.push(' ');
            continue;
        }
        // 只在 ASCII 边界上切分，非 ASCII 字节原样拷贝
        let start = i;
        i += 1;
        while i < bytes.len() && !source.is_char_boundary(i) {
            i += 1;
        }
        out.push_str(&source[start..i]);
    }
    out
}

/// 逻辑行：反斜杠续行合并成一行，行号取首行（1 起）。
fn logical_lines(source: &str) -> Vec<(u32, String)> {
    let mut lines = Vec::new();
    let mut pending: Option<(u32, String)> = None;
    for (index, raw) in source.lines().enumerate() {
        let line_no = index as u32 + 1;
        let raw = raw.trim_end_matches('\r');
        let (start, mut text) = pending.take().unwrap_or((line_no, String::new()));
        if let Some(head) = raw.strip_suffix('\\') {
            text.push_str(head);
            text.push(' ');
            pending = Some((start, text));
        } else {
            text.push_str(raw);
            lines.push((start, text));
        }
    }
    if let Some(rest) = pending {
        lines.push(rest);
    }
    lines
}

/// 拆出行注释：返回（代码, `//` 之后的文字）。
pub fn split_line_comment(line: &str) -> (String, Option<String>) {
    match line.find("//") {
        Some(at) => (line[..at].to_string(), Some(line[at + 2..].to_string())),
        None => (line.to_string(), None),
    }
}

/// 拆出开头的标识符，返回（标识符, 其后的剩余文本）。
pub fn split_ident(text: &str) -> (&str, &str) {
    let end = text
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '_'))
        .map(|(at, _)| at)
        .unwrap_or(text.len());
    (&text[..end], &text[end..])
}

fn include_target(rest: &str) -> Option<&str> {
    let rest = rest.trim();
    let (open, close) = match rest.chars().next()? {
        '"' => ('"', '"'),
        '<' => ('<', '>'),
        _ => return None,
    };
    let inner = rest.strip_prefix(open)?;
    inner.find(close).map(|end| &inner[..end])
}

/// 不看条件分支的注释元数据扫描：COMBO 声明、带注释的采样器声明、引用的头文件。
/// COMBO 要在求值 `#if` 之前确定默认值，采样器的 `combo` / `formatcombo` 也一样，所以必须先于预处理。
#[derive(Debug, Default)]
pub struct Annotations {
    pub combos: Vec<Value>,
    /// （`g_Texture<n>` 的 n, 注释 JSON）
    pub samplers: Vec<(u32, Value)>,
    pub includes: Vec<String>,
}

pub fn scan_annotations(source: &str, out: &mut Annotations) {
    for raw in strip_block_comments(source).lines() {
        let (code, comment) = split_line_comment(raw);
        let trimmed = code.trim();
        if let Some(directive) = trimmed.strip_prefix('#') {
            let (name, rest) = split_ident(directive.trim_start());
            if name == "include" {
                if let Some(target) = include_target(rest) {
                    out.includes.push(target.to_string());
                }
            }
        }
        let Some(comment) = comment else { continue };
        let comment = comment.trim();
        if let Some(json) = comment.strip_prefix("[COMBO]") {
            if let Some(value) = parse_json_object(json) {
                out.combos.push(value);
            }
            continue;
        }
        if let Some(slot) = sampler_slot(trimmed) {
            if let Some(value) = parse_json_object(comment) {
                out.samplers.push((slot, value));
            }
        }
    }
}

/// `uniform sampler2D g_Texture3;` → 3。
fn sampler_slot(code: &str) -> Option<u32> {
    let mut words = code.trim_end_matches(';').split_whitespace();
    if words.next()? != "uniform" || !words.next()?.starts_with("sampler") {
        return None;
    }
    words
        .next()?
        .trim_end_matches(';')
        .strip_prefix("g_Texture")?
        .parse()
        .ok()
}

/// 注释里的 JSON 对象（取第一个 `{` 到最后一个 `}`）；作者偶尔写出不合法的 JSON，解析失败返回 None。
pub fn parse_json_object(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end])
        .ok()
        .filter(Value::is_object)
}

// ---- #if 表达式 ----

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(i64),
    Ident(String),
    Op(&'static str),
}

const OPS: [&str; 24] = [
    "&&", "||", "==", "!=", "<=", ">=", "<<", ">>", "<", ">", "+", "-", "*", "/", "%", "!", "~",
    "&", "|", "^", "?", ":", "(", ")",
];

fn tokenize(expr: &str) -> Result<Vec<Tok>, String> {
    let mut tokens = Vec::new();
    let mut rest = expr.trim_start();
    while !rest.is_empty() {
        let c = rest.chars().next().expect("non-empty");
        if c.is_ascii_digit() {
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
                .map(|(at, _)| at)
                .unwrap_or(rest.len());
            tokens.push(Tok::Num(parse_int(&rest[..end])?));
            rest = &rest[end..];
        } else if c.is_ascii_alphabetic() || c == '_' {
            let (ident, after) = split_ident(rest);
            tokens.push(Tok::Ident(ident.to_string()));
            rest = after;
        } else if let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) {
            tokens.push(Tok::Op(op));
            rest = &rest[op.len()..];
        } else {
            return Err(format!("#if 表达式里无法识别的字符 {c:?}"));
        }
        rest = rest.trim_start();
    }
    Ok(tokens)
}

fn parse_int(text: &str) -> Result<i64, String> {
    let digits = text.trim_end_matches(['u', 'U', 'l', 'L']);
    let parsed = match digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        Some(hex) => i64::from_str_radix(hex, 16),
        None => digits.parse(),
    };
    parsed.map_err(|_| format!("#if 表达式里的数字无法按整数解析：{text}"))
}

struct ExprParser<'t> {
    tokens: &'t [Tok],
    pos: usize,
}

impl ExprParser<'_> {
    fn peek_op(&self) -> Option<&'static str> {
        match self.tokens.get(self.pos) {
            Some(Tok::Op(op)) => Some(op),
            _ => None,
        }
    }

    fn ternary(&mut self) -> Result<i64, String> {
        let cond = self.binary(0)?;
        if self.peek_op() == Some("?") {
            self.pos += 1;
            let yes = self.ternary()?;
            if self.peek_op() != Some(":") {
                return Err("#if 三元表达式缺少 :".into());
            }
            self.pos += 1;
            let no = self.ternary()?;
            return Ok(if cond != 0 { yes } else { no });
        }
        Ok(cond)
    }

    /// 二元运算按 C 优先级（数值越大越紧）。
    fn binary(&mut self, min_prec: u8) -> Result<i64, String> {
        let mut lhs = self.unary()?;
        while let Some(op) = self.peek_op() {
            let prec = match op {
                "||" => 1,
                "&&" => 2,
                "|" => 3,
                "^" => 4,
                "&" => 5,
                "==" | "!=" => 6,
                "<" | ">" | "<=" | ">=" => 7,
                "<<" | ">>" => 8,
                "+" | "-" => 9,
                "*" | "/" | "%" => 10,
                _ => break,
            };
            if prec < min_prec {
                break;
            }
            self.pos += 1;
            let rhs = self.binary(prec + 1)?;
            lhs = match op {
                "||" => i64::from(lhs != 0 || rhs != 0),
                "&&" => i64::from(lhs != 0 && rhs != 0),
                "|" => lhs | rhs,
                "^" => lhs ^ rhs,
                "&" => lhs & rhs,
                "==" => i64::from(lhs == rhs),
                "!=" => i64::from(lhs != rhs),
                "<" => i64::from(lhs < rhs),
                ">" => i64::from(lhs > rhs),
                "<=" => i64::from(lhs <= rhs),
                ">=" => i64::from(lhs >= rhs),
                "<<" => lhs.wrapping_shl(rhs as u32),
                ">>" => lhs.wrapping_shr(rhs as u32),
                "+" => lhs.wrapping_add(rhs),
                "-" => lhs.wrapping_sub(rhs),
                "*" => lhs.wrapping_mul(rhs),
                "/" | "%" if rhs == 0 => return Err("#if 表达式除以 0".into()),
                "/" => lhs.wrapping_div(rhs),
                _ => lhs.wrapping_rem(rhs),
            };
        }
        Ok(lhs)
    }

    fn unary(&mut self) -> Result<i64, String> {
        let token = self.tokens.get(self.pos).cloned();
        self.pos += 1;
        match token {
            Some(Tok::Num(value)) => Ok(value),
            Some(Tok::Op("!")) => Ok(i64::from(self.unary()? == 0)),
            Some(Tok::Op("~")) => Ok(!self.unary()?),
            Some(Tok::Op("-")) => Ok(self.unary()?.wrapping_neg()),
            Some(Tok::Op("+")) => self.unary(),
            Some(Tok::Op("(")) => {
                let value = self.ternary()?;
                if self.peek_op() != Some(")") {
                    return Err("#if 表达式括号没有闭合".into());
                }
                self.pos += 1;
                Ok(value)
            }
            other => Err(format!("#if 表达式意外的记号 {other:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        source: &str,
        defines: &[(&str, &str)],
        includes: &[(&str, &str)],
    ) -> Preprocessor<'static> {
        let includes: &'static BTreeMap<String, String> = Box::leak(Box::new(
            includes
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ));
        let defines = defines
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut pp = Preprocessor::new(includes, &defines);
        pp.run("<test>", source).unwrap();
        pp
    }

    fn code(pp: &Preprocessor) -> Vec<String> {
        pp.lines
            .iter()
            .map(|line| line.code.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect()
    }

    #[test]
    fn undefined_macro_is_zero_and_branches_select() {
        let source = "#if MULTI\na\n#elif QUALITY == 3\nb\n#else\nc\n#endif\n";
        assert_eq!(code(&run(source, &[], &[])), ["c"]);
        assert_eq!(code(&run(source, &[("QUALITY", "3")], &[])), ["b"]);
        assert_eq!(
            code(&run(source, &[("MULTI", "1"), ("QUALITY", "3")], &[])),
            ["a"]
        );
    }

    #[test]
    fn expressions_follow_c_precedence() {
        let pp = run(
            "",
            &[
                ("FORMAT_DXT1", "7"),
                ("FORMAT_BC7", "12"),
                ("TEX1FORMAT", "12"),
            ],
            &[],
        );
        assert_eq!(
            pp.eval("TEX1FORMAT >= 3 && TEX1FORMAT <= FORMAT_DXT1 || TEX1FORMAT == FORMAT_BC7"),
            Ok(1)
        );
        assert_eq!(pp.eval("(LIGHTING || REFLECTION) && NORMALMAP == 0"), Ok(0));
        assert_eq!(pp.eval("defined(FORMAT_BC7) && !defined NOPE"), Ok(1));
        assert_eq!(pp.eval("1 + 2 * 3 == 7 ? 0x10 : 0"), Ok(16));
    }

    #[test]
    fn nested_inactive_groups_stay_inactive() {
        let source = "#if 0\n#if 1\na\n#else\nb\n#endif\n#elif 1\nc\n#endif\n";
        assert_eq!(code(&run(source, &[], &[])), ["c"]);
    }

    #[test]
    fn includes_expand_in_place_and_report_missing() {
        let pp = run(
            "#include \"common.h\"\nx\n#if 0\n#include \"never.h\"\n#endif\n#include \"gone.h\"\n",
            &[],
            &[("common.h", "#define M_PI 3.14\nvec3 f();")],
        );
        assert_eq!(code(&pp), ["#define M_PI 3.14", "vec3 f();", "x"]);
        assert_eq!(pp.missing.iter().collect::<Vec<_>>(), ["gone.h"]);
    }

    /// 几何段跳过顶点段已展开的头文件：头文件里的行不再产出，但其中的 `#define` 照样驱动本段的 `#if`；
    /// `expanded` 只记真正展开过的（含嵌套）。
    #[test]
    fn skipped_includes_keep_macros_but_emit_nothing() {
        let headers = [
            (
                "shared.h",
                "#include \"inner.h\"\n#define HALF 1\nvec3 Shared();",
            ),
            ("inner.h", "float Inner();"),
        ];
        let first = run("#include \"shared.h\"\na\n", &[], &headers);
        assert_eq!(
            code(&first),
            ["float Inner();", "#define HALF 1", "vec3 Shared();", "a"]
        );
        assert_eq!(
            first.expanded.iter().collect::<Vec<_>>(),
            ["inner.h", "shared.h"]
        );

        let includes: BTreeMap<String, String> = headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut second = Preprocessor::new(&includes, &BTreeMap::new());
        second.skip_includes(first.expanded.clone());
        second
            .run("<geometry>", "#include \"shared.h\"\n#if HALF\nb\n#endif\n")
            .unwrap();
        assert_eq!(code(&second), ["b"]);
        assert!(second.expanded.is_empty());
    }

    #[test]
    fn defines_in_source_drive_later_conditions() {
        let source = "#define FORMAT_RG88 8\n#if TEX0FORMAT == FORMAT_RG88\nrg\n#endif\n";
        assert_eq!(
            code(&run(source, &[("TEX0FORMAT", "8")], &[])),
            ["#define FORMAT_RG88 8", "rg"]
        );
    }

    #[test]
    fn comments_metadata_and_array_sizes() {
        let source = "/* block\n#if 1 */\nuniform float g_X; // {\"material\":\"x\"}\nuniform mat4x3 g_Bones[BONECOUNT];\n#require LightingV2\n";
        let pp = run(source, &[("BONECOUNT", "4 * 2")], &[]);
        assert_eq!(
            code(&pp),
            ["uniform float g_X;", "uniform mat4x3 g_Bones[8];"]
        );
        // 块注释剥掉后留下空行，行号不变
        let uniform = pp
            .lines
            .iter()
            .find(|line| line.code.contains("g_X"))
            .unwrap();
        assert_eq!(uniform.line, 3);
        assert!(uniform.comment.as_deref().unwrap().contains("material"));
        assert_eq!(pp.requires.iter().collect::<Vec<_>>(), ["LightingV2"]);
    }

    #[test]
    fn annotations_are_scanned_regardless_of_branches() {
        let mut found = Annotations::default();
        scan_annotations(
            "// [COMBO] {\"combo\":\"LIGHTING\",\"default\":1}\n#if 0\nuniform sampler2D g_Texture1; // {\"combo\":\"NORMALMAP\"}\n#include \"x.h\"\n#endif\n",
            &mut found,
        );
        assert_eq!(found.combos[0]["combo"], "LIGHTING");
        assert_eq!(found.samplers[0].0, 1);
        assert_eq!(found.includes, ["x.h"]);
    }

    #[test]
    fn unbalanced_conditionals_are_errors() {
        let includes = BTreeMap::new();
        let defines = BTreeMap::new();
        let mut pp = Preprocessor::new(&includes, &defines);
        assert!(pp.run("<t>", "#if 1\nx\n").is_err());
        let mut pp = Preprocessor::new(&includes, &defines);
        assert!(pp.run("<t>", "#endif\n").is_err());
    }
}
