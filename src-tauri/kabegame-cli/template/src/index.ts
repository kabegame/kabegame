import { t } from "./i18n";

export async function crawl(common: any, custom: Record<string, unknown>) {
  // TODO: 在这里编写爬取逻辑

  console.log(t("done"));
  Kabegame.addProgress(100.0);
}
