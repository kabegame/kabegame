/**
 * 表单校验（取代 el-form 的 validate）：没有规则对象、没有 async-validator，
 * 每个 Field 自带一个返回错误文字的 validator，表单只负责「提交时一起检查、一起显示」。
 *
 *   const form = useForm();                     // 在表单的根组件里调用，向下提供上下文
 *   <Field :validator="() => (name ? undefined : t('x'))">…</Field>
 *   async function submit() { if (!form.validate()) return; … }
 *
 * 显示时机：某个 Field 的校验结果变过一次（用户改过值）之后，或表单 validate() 过之后。
 * 没有改过、也没提交过的空必填项不提前标红。
 * 被 v-if 隐藏的 Field 卸载时自动注销，不参与校验（插件变量的 `when` 就靠这一条）。
 */
import { inject, provide, ref, type InjectionKey, type Ref } from "vue";

export interface FormFieldHandle {
  /** 当前的错误文字；通过时 undefined */
  error(): string | undefined;
  /** 根元素，validate 失败时滚到第一个出错的 Field */
  el(): HTMLElement | null;
  /** 清掉「改过」标记（reset 用） */
  reset(): void;
}

export interface FormContext {
  register(field: FormFieldHandle): () => void;
  /** validate() 过之后为 true：所有 Field 都显示错误 */
  submitted: Ref<boolean>;
}

export const FORM_KEY: InjectionKey<FormContext> = Symbol("kbForm");

export function useFormContext(): FormContext | null {
  return inject(FORM_KEY, null);
}

export interface FormApi {
  /** 检查全部已挂载的 Field，并让它们都显示错误；全部通过时 true。第一个出错的 Field 滚进视野 */
  validate(): boolean;
  /** 回到初始显示状态（重新打开对话框时用）：不显示任何错误 */
  reset(): void;
  submitted: Ref<boolean>;
}

/** 在表单根组件里调用：向子孙的 Field 提供上下文，返回 validate / reset */
export function useForm(): FormApi {
  const fields = new Set<FormFieldHandle>();
  const submitted = ref(false);

  provide(FORM_KEY, {
    register(field) {
      fields.add(field);
      return () => fields.delete(field);
    },
    submitted,
  });

  function validate(): boolean {
    submitted.value = true;
    const invalid = [...fields].filter((f) => f.error());
    if (invalid.length === 0) return true;
    // 按文档顺序取第一个（注册顺序不一定是显示顺序）
    const first = invalid
      .map((f) => f.el())
      .filter((el): el is HTMLElement => !!el)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
    // 不用 smooth：这个 CEF 里平滑滚动不动（实测）
    first?.scrollIntoView({ block: "nearest" });
    return false;
  }

  function reset() {
    submitted.value = false;
    for (const f of fields) f.reset();
  }

  return { validate, reset, submitted };
}
