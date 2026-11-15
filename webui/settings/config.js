const configState = { dirty: false, busy: false };
window.MemeSettings = configState;

async function initPluginConfig() {
  await window.AstrBotPluginPage.ready();
  const api = window.AstrBotPluginPage;
  const form = document.getElementById("plugin-config-form");
  const sections = document.getElementById("config-sections");
  const search = document.getElementById("settings-search");
  const save = document.getElementById("save-config-btn");
  const reload = document.getElementById("reload-config-btn");
  const status = document.getElementById("config-save-status");
  const notice = document.getElementById("config-load-status");
  const mode = document.getElementById("selection-mode-panel");
  const empty = document.getElementById("config-search-empty");
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  const panels = [...document.querySelectorAll("[data-settings-panel]")];
  const fields = new Map();
  const changes = new Map();
  const validTabs = new Set(tabs.map((tab) => tab.dataset.settingsTab));
  let active = validTabs.has(location.hash.slice(1)) ? location.hash.slice(1) : "models";
  let revision = "";
  let loaded = false;

  const headings = {
    models: ["使用方式", "按当前会话的规则查找表情，由 Alma 决定如何表达。"],
    matching: ["检索与描述", "调整候选、匹配分、分类过滤和图片描述模型。"],
    preview: ["页面预览", "调整管理页面同时加载的图片数量。"],
  };

  function category(field) {
    return field.path.startsWith("webui.") ? "preview" : "matching";
  }

  function updateView() {
    const query = search.value.trim().toLocaleLowerCase();
    const configVisible = Boolean(query) || active in headings;
    for (const panel of panels) {
      panel.hidden = panel.dataset.settingsPanel === "config"
        ? !configVisible : Boolean(query) || panel.dataset.settingsPanel !== active;
    }
    for (const tab of tabs) {
      if (!query && tab.dataset.settingsTab === active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    const [title, description] = query
      ? ["搜索结果", "按设置名称或说明查找。"] : headings[active] || ["", ""];
    document.getElementById("config-section-title").textContent = title;
    document.getElementById("config-section-description").textContent = description;
    mode.hidden = !loaded || Boolean(query) || active !== "models";
    let visible = 0;
    for (const card of sections.children) {
      let count = 0;
      for (const row of card.querySelectorAll("[data-field-path]")) {
        const field = fields.get(row.dataset.fieldPath);
        const matches = query
          ? [field.label, field.hint, field.path].join(" ").toLocaleLowerCase().includes(query)
          : category(field) === active;
        row.hidden = !matches;
        if (matches) count += 1;
      }
      card.hidden = !count;
      visible += count;
    }
    sections.hidden = !visible;
    empty.hidden = !loaded || !query || visible > 0;
  }

  function updateState(message = "", error = false) {
    configState.dirty = changes.size > 0;
    save.disabled = !loaded || !changes.size || configState.busy;
    reload.disabled = configState.busy;
    sections.inert = configState.busy;
    form.setAttribute("aria-busy", String(configState.busy));
    status.textContent = message || (changes.size
      ? `有 ${changes.size} 项更改未保存` : loaded ? "所有更改已保存" : "正在读取设置…");
    status.classList.toggle("error", error);
    for (const tab of tabs) {
      const dot = tab.querySelector(".settings-dirty-dot");
      if (dot) dot.hidden = ![...changes.keys()].some((path) => category(fields.get(path)) === tab.dataset.settingsTab);
    }
  }

  function fieldControl(field, providers) {
    let control;
    if (field.special === "select_provider") {
      control = document.createElement("select");
      control.append(new Option("自动选择可用视觉模型", ""));
      for (const provider of providers.chat || []) {
        if (provider.vision) control.append(new Option(`${provider.provider} · ${provider.model}`, provider.id));
      }
      if (field.value && ![...control.options].some((option) => option.value === field.value)) {
        control.append(new Option(`${field.value}（当前不可用）`, field.value));
      }
      control.value = field.value || "";
    } else if (field.type === "list") {
      control = document.createElement("textarea");
      control.rows = 3;
      control.value = (field.value || []).join("\n");
    } else {
      control = document.createElement("input");
      control.type = field.type === "bool" ? "checkbox"
        : ["int", "float"].includes(field.type) ? "number" : "text";
      if (field.type === "bool") control.checked = Boolean(field.value);
      else control.value = field.value ?? "";
      if (control.type === "number") {
        control.required = true;
        control.step = field.bounds?.step ?? (field.type === "int" ? 1 : 0.01);
        if (Number.isFinite(field.bounds?.min)) control.min = field.bounds.min;
        if (Number.isFinite(field.bounds?.max)) control.max = field.bounds.max;
      }
    }
    control.id = `config-${field.path.replace(/[^a-z0-9-]/gi, "-")}`;
    control.dataset.configPath = field.path;
    const changed = () => {
      const value = field.type === "bool" ? control.checked
        : ["int", "float"].includes(field.type) ? Number(control.value)
        : field.type === "list" ? [...new Set(control.value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean))]
        : control.value;
      if (JSON.stringify(value) === JSON.stringify(field.value)) changes.delete(field.path);
      else changes.set(field.path, value);
      updateState();
    };
    control.addEventListener(control.type === "checkbox" || control.tagName === "SELECT" ? "change" : "input", changed);
    return control;
  }

  function render(snapshot) {
    fields.clear();
    sections.replaceChildren();
    const cards = new Map();
    for (const field of snapshot.fields || []) {
      fields.set(field.path, field);
      const group = field.groups?.[0] || "设置";
      if (!cards.has(group)) {
        const card = document.createElement("section");
        card.className = "panel config-card";
        const header = document.createElement("header");
        header.className = "config-card-header";
        const heading = document.createElement("h3");
        heading.textContent = group;
        header.append(heading);
        const body = document.createElement("div");
        body.className = "config-card-body";
        card.append(header, body);
        cards.set(group, body);
        sections.append(card);
      }
      const row = document.createElement("div");
      row.className = "alma-settings-field";
      row.dataset.fieldPath = field.path;
      const control = fieldControl(field, snapshot.providers || {});
      const label = document.createElement("label");
      label.htmlFor = control.id;
      label.textContent = field.label;
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = field.hint;
      row.append(label, control, hint);
      cards.get(group).append(row);
    }
    updateView();
  }

  async function load() {
    configState.busy = true;
    notice.hidden = false;
    notice.classList.remove("error");
    notice.textContent = "正在读取配置…";
    updateState();
    try {
      const snapshot = await api.apiGet("settings/config");
      revision = snapshot.revision;
      changes.clear();
      loaded = true;
      render(snapshot);
      notice.hidden = true;
    } catch (error) {
      notice.textContent = `读取失败：${error.message}。请重新加载。`;
      notice.classList.add("error");
    } finally {
      configState.busy = false;
      updateState();
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      active = tab.dataset.settingsTab;
      search.value = "";
      history.replaceState(null, "", `${location.pathname}${location.search}#${active}`);
      updateView();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  window.addEventListener("hashchange", () => {
    if (validTabs.has(location.hash.slice(1))) active = location.hash.slice(1);
    updateView();
  });
  search.addEventListener("input", updateView);
  reload.addEventListener("click", async () => {
    if (changes.size && !await window.MemeUI.confirm({
      title: "重新加载设置", message: "当前未保存的更改会被重新读取的设置覆盖。", confirmText: "重新加载",
    })) return;
    await load();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (configState.busy || !changes.size || !form.reportValidity()) return;
    configState.busy = true;
    updateState("正在保存…");
    let message = "";
    let failed = false;
    try {
      const snapshot = await api.apiPost("settings/config", { revision, changes: Object.fromEntries(changes) });
      revision = snapshot.revision;
      changes.clear();
      render(snapshot);
      notice.hidden = true;
      message = snapshot.message || "设置已保存并生效。";
    } catch (error) {
      failed = true;
      message = `${error.message}。更改仍保留，可重新提交。`;
    } finally {
      configState.busy = false;
      updateState(message, failed);
    }
  });
  updateView();
  await load();
}

void initPluginConfig().catch((error) => window.MemeUI.showPageError(error));
