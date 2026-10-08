<script setup lang="ts">
import { IconArrowRight, IconLibrary } from '@jannchie/icons'
import { app } from './app'
import { langRef, t } from './i18n'
import Icon from './kit/Icon.vue'
import LangSelect from './LangSelect.vue'

const emit = defineEmits<{ open: [] }>()
const BASE = import.meta.env.BASE_URL
// 封面图（scripts/plates.ts 生成）：地名跟着界面语言，世界用等高线皮肤、聚落用彩绘皮肤
const plates = [
  {
    go: 'world' as const,
    no: 'I',
    title: '世界地图',
    desc: '板块造山、侵蚀水系、气候与群系。3D 沙盘、六种纸图风格，并可在编辑视图里改地形、气候、大洲与地点。',
    img: 'world',
  },
  {
    go: 'settlement' as const,
    no: 'II',
    title: '聚落地图',
    desc: '从小村到大城的街区级平面图：城墙城门、街巷街坊、房屋院落、河桥港口与农田；西式或东方，写实或奇幻。可继承世界地图上某座城镇的环境。',
    img: 'town',
  },
]
</script>

<template>
  <div class="home">
    <div class="home-sheet">
      <header class="home-title">
        <h1>Cartographer</h1>
        <p>{{ t('为你的世界观绘制地图：从整片大陆的山川气候，到一座城镇的街巷。') }}</p>
      </header>
      <div class="plates">
        <button v-for="(pl, i) in plates" :key="pl.go" type="button" class="plate" :style="{ '--i': i }" @click="app.module = pl.go">
          <span class="plate-img"><img :src="`${BASE}plates/${pl.img}-${langRef}.webp`" alt="" width="1200" height="752" /></span>
          <span class="plate-cap">
            <span class="plate-no">{{ t('图版') }} {{ pl.no }}</span>
            <span class="plate-title">{{ t(pl.title) }}<Icon :icon="IconArrowRight" :size="18" /></span>
            <span class="plate-desc">{{ t(pl.desc) }}</span>
          </span>
        </button>
      </div>
      <footer class="home-foot">
        <button type="button" class="link" @click="emit('open')"><Icon :icon="IconLibrary" :size="14" />{{ t('世界库…') }}</button>
        <LangSelect />
      </footer>
    </div>
  </div>
</template>
