import { defineI18n } from "@kabegame/plugin-sdk";
import en from "./en.json";
import ja from "./ja.json";
import ko from "./ko.json";
import zh from "./zh.json";
import zhtw from "./zhtw.json";

export const t = defineI18n("en", { zh, en, ja, ko, zhtw });
