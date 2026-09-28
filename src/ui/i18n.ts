import { ref } from 'vue'
import { lang, onLang, t as translate, type Lang } from '../i18n'

/** 当前语言的响应式镜像：模板里的 t() 读它，切换语言时整棵界面自动重译 */
export const langRef = ref<Lang>(lang)
onLang(() => (langRef.value = lang))

export function t(key: string, vars?: Record<string, string | number>) {
  void langRef.value
  return translate(key, vars)
}
