type Translate = (zh: string, en: string) => string;

export function rollingStatusPanel(t: Translate): string {
  return `<template x-if="dreamStatus && dreamStatus.rolling">
    <section class="panel panel-pad">
      <h2 class="h2">${t("滚动整理", "Rolling memory")}</h2>
      <p class="mt-2 text-sm muted" x-text="L('收件箱积压 ', 'Inbox backlog ') + dreamStatus.rolling.backlog + ' · ' + dreamStatus.rolling.mode"></p>
      <p x-show="dreamStatus.rolling.active_window" class="mt-1 text-sm" x-text="L('有窗口正在处理', 'A window is running')"></p>
      <template x-if="dreamStatus.rolling.recent_windows.length">
        <div class="mt-3 space-y-1">
          <h3 class="font-semibold">${t("最近窗口", "Recent windows")}</h3>
          <template x-for="window in dreamStatus.rolling.recent_windows" :key="window.window_key">
            <p class="text-xs muted" x-text="new Date(window.finished_at).toLocaleString() + ' · ' + window.mode + ' · Clef ' + window.clef_calls + L(' 次 · 抽取 ', ' calls · extraction ') + window.extractor_calls + L(' 次', ' calls')"></p>
          </template>
        </div>
      </template>
      <template x-if="dreamStatus.rolling.failed_windows.length">
        <div class="mt-3 space-y-1">
          <h3 class="font-semibold">${t("失败窗口", "Failed windows")}</h3>
          <template x-for="window in dreamStatus.rolling.failed_windows" :key="window.window_key">
            <p class="text-xs muted" x-text="new Date(window.finished_at).toLocaleString() + ' · ' + window.error"></p>
          </template>
        </div>
      </template>
    </section>
  </template>`;
}

export function rollingHarvestPanel(t: Translate): string {
  return `<template x-if="dreamHarvest && dreamHarvest.rolling">
    <div class="grid gap-3 p-[18px] pt-0 md:grid-cols-2">
      <div>
        <h3 class="font-semibold">${t("夜间产出", "Nightly outputs")}</h3>
        <p x-show="dreamHarvest.rolling.nightly.length === 0" class="mt-2 text-xs muted">${t("这一天还没有对应的夜间产出。", "No nightly outputs are linked to this day yet.")}</p>
        <template x-for="item in dreamHarvest.rolling.nightly" :key="item.id">
          <p class="mt-2 text-sm" x-text="item.content"></p>
        </template>
      </div>
      <div>
        <h3 class="font-semibold">${t("滚动本会写入", "What rolling would write")}</h3>
        <p x-show="dreamHarvest.rolling.shadow.length === 0" class="mt-2 text-xs muted">${t("这一天还没有影子产出。", "No shadow outputs for this day yet.")}</p>
        <template x-for="item in dreamHarvest.rolling.shadow" :key="item.id">
          <p class="mt-2 text-sm"><span class="chip chip-dim" x-text="item.op"></span> <span x-text="item.content"></span></p>
        </template>
      </div>
    </div>
  </template>`;
}
