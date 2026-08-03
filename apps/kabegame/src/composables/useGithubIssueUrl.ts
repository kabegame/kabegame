import { i18n } from "@kabegame/i18n";
import { openExternalLink } from "@kabegame/core/utils/openExternalLink";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { useApp } from "@/stores/app";

const KABEGAME_NEW_ISSUE_URL = "https://github.com/kabegame/kabegame/issues/new";

export interface GithubIssueField {
  label: string;
  value: string | number | null | undefined;
}

export interface GithubIssueSection {
  /** 分组标题，如「任务信息」；分组内所有 field 均为空时整段不出现在正文里 */
  heading: string;
  fields: GithubIssueField[];
}

export interface GithubIssueOptions {
  /** issue 标题 */
  title: string;
  /** 问题描述，出现在正文最前面（环境信息之前） */
  description?: string;
  /** 调用方按场景扩展的详情分组；负责自行过滤敏感字段（如 cookie、token、用户配置） */
  sections?: GithubIssueSection[];
}

function platformLabel(): string {
  if (IS_ANDROID) return "Android";
  if (IS_WEB) return "Web";
  return "Desktop";
}

function renderSection(section: GithubIssueSection): string | null {
  const rows = section.fields.filter(
    (f) => f.value !== null && f.value !== undefined && String(f.value).trim() !== "",
  );
  if (!rows.length) return null;
  return [`### ${section.heading}`, ...rows.map((f) => `- ${f.label}: ${f.value}`)].join("\n");
}

/** 生成预填「应用版本 + 平台」等基础环境信息、并可按场景扩展详情分组的 GitHub 新建 issue 链接 */
export function useGithubIssueUrl() {
  const appStore = useApp();

  function buildIssueUrl(options: GithubIssueOptions): string {
    const t = i18n.global.t;
    const envSection = renderSection({
      heading: t('common["reportIssue.envSection"]'),
      fields: [
        { label: t('common["reportIssue.appVersion"]'), value: appStore.version ?? "unknown" },
        { label: t('common["reportIssue.platform"]'), value: platformLabel() },
      ],
    });

    const blocks = [
      options.description?.trim(),
      envSection,
      ...(options.sections ?? []).map(renderSection),
    ].filter((block): block is string => !!block);

    const params = new URLSearchParams({ title: options.title, body: blocks.join("\n\n") });
    return `${KABEGAME_NEW_ISSUE_URL}?${params.toString()}`;
  }

  async function openIssue(options: GithubIssueOptions): Promise<void> {
    await openExternalLink(buildIssueUrl(options));
  }

  return { buildIssueUrl, openIssue };
}
