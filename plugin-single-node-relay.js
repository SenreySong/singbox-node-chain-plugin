const DATA_DIR = 'data/third/single-node-relay'
const CONFIG_FILE = DATA_DIR + '/rules.json'
const GROUP_OUTBOUND_TYPES = new Set(['selector', 'urltest'])
const EXCLUDED_OUTBOUND_TYPES = new Set(['direct', 'block', 'dns'])

window[Plugin.id] = window[Plugin.id] || {
  rules: Vue.ref([]),
  loaded: false
}

const getState = () => window[Plugin.id]

const ensureDataDir = async () => {
  if (!(await Plugins.FileExists('data/third').catch(() => false))) {
    await Plugins.MakeDir('data/third')
  }
  if (!(await Plugins.FileExists(DATA_DIR).catch(() => false))) {
    await Plugins.MakeDir(DATA_DIR)
  }
  if (!(await Plugins.FileExists(CONFIG_FILE).catch(() => false))) {
    await Plugins.WriteFile(CONFIG_FILE, '[]')
  }
}

const readRules = async () => {
  await ensureDataDir()
  const content = await Plugins.ReadFile(CONFIG_FILE).catch(() => '[]')
  try {
    const rules = JSON.parse(content)
    return normalizeRules(Array.isArray(rules) ? rules : [])
  } catch {
    return []
  }
}

const saveRules = async (rules) => {
  await ensureDataDir()
  await Plugins.WriteFile(CONFIG_FILE, JSON.stringify(normalizeRules(rules), null, 2))
}

const loadRules = async () => {
  if (!getState().loaded) {
    getState().rules.value = await readRules()
    getState().loaded = true
  }
  return getState().rules.value
}

const normalizeRules = (rules) => {
  const seen = new Set()
  return (rules || [])
    .map((rule) => ({
      id: rule.id || Plugins.sampleID(),
      profileId: String(rule.profileId || ''),
      sourceTag: String(rule.sourceTag || '').trim(),
      relayTag: String(rule.relayTag || '').trim(),
      enabled: rule.enabled !== false
    }))
    .filter((rule) => {
      if (!rule.profileId || !rule.sourceTag) return false
      const key = `${rule.profileId}\n${rule.sourceTag}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const onReady = async () => {
  await loadRules()
}

const onRun = async () => {
  const profile = await selectProfile()
  if (!profile) return
  await openManager(profile)
}

const onBeforeCoreStart = async (config, profile) => {
  const rules = await loadRules()
  const profileRules = rules.filter((rule) => rule.profileId === profile.id)
  if (profileRules.length === 0) return config

  const context = buildConfigContext(config)
  const nextRules = reconcileMissingRelays(profileRules, context)
  if (JSON.stringify(nextRules) !== JSON.stringify(profileRules)) {
    const allRules = rules.filter((rule) => rule.profileId !== profile.id).concat(nextRules)
    getState().rules.value = normalizeRules(allRules)
    await saveRules(getState().rules.value)
    Plugins.message.warn('部分中转节点已不存在，已自动清空对应中转配置')
  }

  const links = buildValidatedLinks(nextRules, context)
  applyDetours(config, links)
  return config
}

const selectProfile = async () => {
  const profilesStore = Plugins.useProfilesStore()
  const profiles = profilesStore.profiles || []
  if (profiles.length === 0) throw '请先创建一个配置'
  if (profiles.length === 1) return profiles[0]
  return Plugins.picker.single(
    '请选择配置',
    profiles.map((profile) => ({
      label: profile.name,
      value: profile
    })),
    [profilesStore.currentProfile || profiles[0]]
  )
}

const openManager = async (profile) => {
  const { ref, computed, h, watch } = Vue
  const allRules = await loadRules()
  const generatedConfig = await Plugins.generateConfig(profile, { enablePluginProcessing: false })
  const context = buildConfigContext(generatedConfig)
  const profileRules = normalizeRules(allRules.filter((rule) => rule.profileId === profile.id))
  const rules = ref(ensureRows(profileRules, context, profile.id))
  const keyword = ref('')

  const nodeOptions = computed(() => {
    return Array.from(context.outboundByTag.values())
      .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN'))
      .map((outbound) => ({
        label: `${outbound.tag} (${outbound.type})`,
        value: outbound.tag
      }))
  })

  const filteredRules = computed(() => {
    const text = keyword.value.trim().toLowerCase()
    if (!text) return rules.value
    return rules.value.filter((rule) => {
      const content = `${rule.sourceTag} ${rule.relayTag} ${rule.enabled ? '启用' : '停用'}`.toLowerCase()
      return content.includes(text)
    })
  })

  const component = {
    template: `
    <div class="flex flex-col gap-8 pr-8">
      <div class="grid items-center gap-8" style="grid-template-columns: minmax(0, 1fr) 220px auto;">
        <div class="flex items-center gap-8 min-w-0">
          <div class="font-bold text-16 truncate" :title="profileName + ' 节点中转'">{{ profileName }} 节点中转</div>
          <div class="text-12 shrink-0" style="padding: 2px 6px; border: 1px solid #94a3b8; border-radius: 4px; background: #f8fafc; color: #334155;">
            {{ pluginVersion }}
          </div>
        </div>
        <Input v-model="keyword" placeholder="搜索节点" allow-paste />
        <Button type="primary" @click="save">保存配置</Button>
      </div>

      <Card>
        <div class="flex flex-col gap-8" style="max-height: 520px; overflow: auto;">
          <div
            v-for="rule in filteredRules"
            :key="rule.id"
            class="grid items-center gap-8 rounded-4 p-8"
            style="grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.4fr) 86px; border: 1px solid #cbd5e1; background: #f8fafc;"
          >
            <div class="min-w-0">
              <div class="text-12 text-gray-500">节点</div>
              <div class="font-bold text-13 truncate" :title="rule.sourceTag">{{ rule.sourceTag }}</div>
              <div class="text-12 truncate" style="color: #64748b;" :title="getOutboundType(rule.sourceTag)">
                {{ getOutboundType(rule.sourceTag) }}
              </div>
            </div>
            <div class="min-w-0">
              <div class="text-12 text-gray-500">中转节点</div>
              <button type="button" :style="relayButtonStyle" :title="renderRelayLabel(rule)" @click="openRelayPicker(rule)">
                {{ renderRelayLabel(rule) }}
              </button>
              <div class="text-12 truncate" style="color: #92400e;" :title="getRuleWarning(rule)">
                {{ getRuleWarning(rule) }}
              </div>
            </div>
            <div class="flex justify-end">
              <Switch v-model="rule.enabled">启用</Switch>
            </div>
          </div>
          <div v-if="filteredRules.length === 0" class="flex items-center justify-center min-h-[120px] border border-dashed rounded-4">
            <div class="text-12 text-gray-500">没有匹配节点</div>
          </div>
        </div>
      </Card>

      <div class="flex items-center justify-between gap-8">
        <div class="text-12" style="color: #64748b;">
          保存内容只写入插件目录，不修改订阅和 GUI 配置；核心启动前会按当前配置写入 detour。
        </div>
        <Button type="text" @click="clearRelays">清空当前配置中转</Button>
      </div>
    </div>
    `,
    setup() {
      const relayButtonStyle =
        'width: 100%; min-height: 30px; padding: 0 10px; border: 1px solid #94a3b8; border-radius: 4px; background: #ffffff; color: #0f172a; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
      const optionButtonStyle =
        'width: 100%; min-height: 30px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 4px; background: #f8fafc; color: #0f172a; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
      watch(
        rules,
        (items) => {
          items.forEach((rule) => {
            if (!context.outboundByTag.has(rule.sourceTag)) {
              rule.enabled = false
              rule.relayTag = ''
            }
            if (rule.relayTag && !context.outboundByTag.has(rule.relayTag)) {
              rule.relayTag = ''
            }
          })
        },
        { deep: true }
      )

      const getOutboundType = (tag) => {
        return context.outboundByTag.get(tag)?.type || '不存在'
      }

      const renderRelayLabel = (rule) => {
        if (!rule.relayTag) return '无中转'
        return `${rule.relayTag} (${getOutboundType(rule.relayTag)})`
      }

      const getRuleWarning = (rule) => {
        if (!rule.enabled) return ''
        if (!rule.relayTag) return ''
        if (rule.sourceTag === rule.relayTag) return '不能选择自身作为中转'
        const draftLinks = buildValidatedLinks(rules.value, context, { throwOnCycle: false })
        if (draftLinks.invalidCycles.has(rule.sourceTag)) return '当前链路存在循环'
        return renderChain(rule.sourceTag, draftLinks.links)
      }

      const openRelayPicker = (rule) => {
        const pickerKeyword = ref('')
        const pickerOptions = computed(() => {
          const text = pickerKeyword.value.trim().toLowerCase()
          if (!text) return nodeOptions.value
          return nodeOptions.value.filter((option) => {
            const content = `${option.label} ${option.value}`.toLowerCase()
            return content.includes(text)
          })
        })

        const pickerComponent = {
          template: `
          <div class="flex flex-col gap-8 p-8">
            <Input v-model="pickerKeyword" placeholder="搜索节点 tag 或类型" allow-paste />
            <button type="button" :style="optionButtonStyle" @click="chooseRelay('')">无中转</button>
            <div class="flex flex-col gap-6" style="max-height: 360px; overflow: auto;">
              <button
                v-for="option in pickerOptions"
                :key="option.value"
                type="button"
                :style="optionButtonStyle"
                :title="option.label"
                @click="chooseRelay(option.value)"
              >
                {{ option.label }}
              </button>
              <div v-if="pickerOptions.length === 0" class="flex items-center justify-center min-h-[96px] border border-dashed rounded-4">
                <div class="text-12 text-gray-500">没有匹配节点</div>
              </div>
            </div>
          </div>
          `,
          setup() {
            const chooseRelay = (relayTag) => {
              rule.relayTag = relayTag
              pickerModal.close()
            }

            return {
              pickerKeyword,
              pickerOptions,
              optionButtonStyle,
              chooseRelay
            }
          }
        }

        const pickerModal = Plugins.modal(
          {
            title: `选择「${rule.sourceTag}」的中转节点`,
            width: '620px',
            height: '520px',
            footer: false,
            maskClosable: true,
            afterClose() {
              pickerModal.destroy()
            }
          },
          {
            default: () => h(pickerComponent)
          }
        )
        pickerModal.open()
      }

      const clearRelays = async () => {
        if (!(await Plugins.confirm('清空中转配置', `确定清空「${profile.name}」的所有节点中转吗？`).catch(() => false))) {
          return
        }
        rules.value.forEach((rule) => {
          rule.relayTag = ''
        })
      }

      const save = async () => {
        const normalized = normalizeRules(rules.value)
        validateRulesForSave(normalized, context)
        const currentSourceTags = new Set(context.outboundByTag.keys())
        const otherRules = getState().rules.value.filter((rule) => rule.profileId !== profile.id)
        const hiddenProfileRules = getState().rules.value.filter(
          (rule) => rule.profileId === profile.id && !currentSourceTags.has(rule.sourceTag)
        )
        const savedRules = otherRules.concat(hiddenProfileRules, normalized.filter((rule) => rule.relayTag))
        getState().rules.value = normalizeRules(savedRules)
        await saveRules(getState().rules.value)
        await restartCoreIfCurrentProfile(profile)
        modal.close()
      }

      return {
        pluginVersion: Plugin.version || '',
        profileName: profile.name,
        keyword,
        rules,
        filteredRules,
        relayButtonStyle,
        getOutboundType,
        renderRelayLabel,
        getRuleWarning,
        openRelayPicker,
        clearRelays,
        save
      }
    }
  }

  const modal = Plugins.modal(
    {
      title: '节点中转配置',
      submit: false,
      width: '82',
      height: '78',
      cancelText: '关闭',
      afterClose() {
        modal.destroy()
      }
    },
    {
      default: () => h(component)
    }
  )
  modal.open()
}

const ensureRows = (storedRules, context, profileId) => {
  const ruleBySource = new Map(storedRules.map((rule) => [rule.sourceTag, rule]))
  return Array.from(context.outboundByTag.keys())
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((sourceTag) => {
      const saved = ruleBySource.get(sourceTag)
      return {
        id: saved?.id || Plugins.sampleID(),
        profileId,
        sourceTag,
        relayTag: saved?.relayTag && context.outboundByTag.has(saved.relayTag) ? saved.relayTag : '',
        enabled: saved?.enabled !== false
      }
    })
}

const buildConfigContext = (config) => {
  const outboundByTag = new Map()
  for (const outbound of config.outbounds || []) {
    if (!isChainableOutbound(outbound)) continue
    outboundByTag.set(outbound.tag, outbound)
  }
  return { outboundByTag }
}

const isChainableOutbound = (outbound) => {
  if (!outbound?.tag) return false
  if (GROUP_OUTBOUND_TYPES.has(outbound.type)) return false
  if (EXCLUDED_OUTBOUND_TYPES.has(outbound.type)) return false
  return true
}

const reconcileMissingRelays = (rules, context) => {
  return normalizeRules(rules).map((rule) => {
    if (!rule.relayTag) return rule
    if (!context.outboundByTag.has(rule.sourceTag)) return rule
    if (!context.outboundByTag.has(rule.relayTag)) {
      return {
        ...rule,
        relayTag: ''
      }
    }
    return rule
  })
}

const validateRulesForSave = (rules, context) => {
  for (const rule of rules) {
    if (!context.outboundByTag.has(rule.sourceTag)) {
      throw `节点不存在：${rule.sourceTag}`
    }
    if (rule.relayTag && !context.outboundByTag.has(rule.relayTag)) {
      throw `中转节点不存在：${rule.relayTag}`
    }
    if (rule.relayTag && rule.sourceTag === rule.relayTag) {
      throw `节点「${rule.sourceTag}」不能选择自身作为中转`
    }
  }

  buildValidatedLinks(rules, context)
}

const buildValidatedLinks = (rules, context, options = {}) => {
  const throwOnCycle = options.throwOnCycle !== false
  const links = new Map()
  const invalidCycles = new Set()

  for (const rule of normalizeRules(rules)) {
    if (rule.enabled === false) continue
    if (!rule.relayTag) continue
    if (!context.outboundByTag.has(rule.sourceTag)) continue
    if (!context.outboundByTag.has(rule.relayTag)) continue
    if (rule.sourceTag === rule.relayTag) {
      invalidCycles.add(rule.sourceTag)
      continue
    }
    links.set(rule.sourceTag, rule.relayTag)
  }

  for (const sourceTag of links.keys()) {
    const cycle = findCycle(sourceTag, links)
    if (cycle.length === 0) continue
    cycle.forEach((tag) => invalidCycles.add(tag))
  }

  if (invalidCycles.size > 0 && throwOnCycle) {
    throw `节点中转配置存在循环：${Array.from(invalidCycles).join(' -> ')}`
  }

  return { links, invalidCycles }
}

const findCycle = (sourceTag, links) => {
  const path = []
  const indexByTag = new Map()
  let current = sourceTag

  while (links.has(current)) {
    if (indexByTag.has(current)) {
      return path.slice(indexByTag.get(current)).concat(current)
    }
    indexByTag.set(current, path.length)
    path.push(current)
    current = links.get(current)
  }

  return []
}

const applyDetours = (config, linkResult) => {
  const links = linkResult.links || linkResult
  for (const outbound of config.outbounds || []) {
    if (!outbound?.tag) continue
    const relayTag = links.get(outbound.tag)
    if (relayTag) {
      outbound.detour = relayTag
    }
  }
}

const restartCoreIfCurrentProfile = async (profile) => {
  const kernelApiStore = Plugins.useKernelApiStore()
  if (!kernelApiStore.running) {
    Plugins.message.success('节点中转配置已保存，启动核心后生效')
    return
  }

  const appSettingsStore = Plugins.useAppSettingsStore()
  const currentProfileId = appSettingsStore.app.kernel.profile
  if (currentProfileId !== profile.id) {
    Plugins.message.success('节点中转配置已保存，当前运行的不是此配置，未重启核心')
    return
  }

  Plugins.message.info('节点中转配置已保存，正在重启核心...')
  await kernelApiStore.restartCore()
  Plugins.message.success('核心已重启，节点中转配置已生效')
}

const renderChain = (sourceTag, links) => {
  const parts = [sourceTag]
  const seen = new Set([sourceTag])
  let current = sourceTag

  while (links.has(current)) {
    current = links.get(current)
    parts.push(current)
    if (seen.has(current)) {
      parts.push('循环')
      break
    }
    seen.add(current)
  }

  return parts.join(' -> ')
}

export default {
  onReady,
  onRun,
  onBeforeCoreStart
}
