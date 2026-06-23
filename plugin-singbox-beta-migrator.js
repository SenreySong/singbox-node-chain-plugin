const DATA_DIR = 'data/third/singbox-beta-migrator'
const SETTINGS_FILE = DATA_DIR + '/settings.json'

const RUN_MODES = [
  '仅测试版核心,beta_only',
  '总是启用,always',
  '仅预览,preview_only'
]
const DEFAULT_SETTINGS = {
  enabled: true,
  runMode: 'beta_only',
  manualKernelVersion: '',
  notifyOnApply: true,
  recommendationToggles: {
    dnsCache: true,
    cacheFileStoreDns: true,
    directOverride: true,
    dnsResponseMatch: false,
    inboundLegacyFields: false
  },
  featureToggles: {
    routeDefaultDomainResolver: true
  }
}
const CONVERSION_DEFINITIONS = [
  {
    id: 'legacy-dns-server',
    level: 'force',
    title: '旧 DNS 服务器格式转换',
    description: '把 dns.servers 中只有 address 的旧格式转换为 1.14 新格式。'
  },
  {
    id: 'outbound-dns-rule',
    level: 'force',
    title: 'outbound DNS 规则迁移',
    description: '把 dns.rules 中的 outbound/server 规则迁移到出站 domain_resolver。'
  },
  {
    id: 'tun-route-address',
    level: 'force',
    title: 'TUN 路由地址字段合并',
    description: '把 inet4/inet6_route_address 与 exclude 字段合并为 route_address / route_exclude_address。'
  },
  {
    id: 'dns-cache',
    level: 'recommend',
    title: '移除 independent_cache',
    description: '1.14 中 DNS 缓存始终按传输分离，建议删除 dns.independent_cache。'
  },
  {
    id: 'cache-file-store-dns',
    level: 'recommend',
    title: 'store_rdrc 改为 store_dns',
    description: '把 experimental.cache_file.store_rdrc 迁移为 store_dns。'
  },
  {
    id: 'direct-override',
    level: 'recommend',
    title: 'direct 出站目标覆盖迁移',
    description: '把 direct 出站的 override_address / override_port 转为 route-options 规则。'
  },
  {
    id: 'dns-response-match',
    level: 'recommend',
    title: 'DNS 响应匹配迁移提示',
    description: '旧 DNS 地址筛选字段需要按语义迁移为 evaluate + match_response，插件只提示不自动改。'
  },
  {
    id: 'inbound-legacy-fields',
    level: 'recommend',
    title: '旧入站字段迁移提示',
    description: 'sniff / domain_strategy 等旧入站字段可迁移到规则动作，插件只提示不自动改。'
  }
]
const FEATURE_DEFINITIONS = [
  {
    id: 'route-default-domain-resolver',
    title: '注入默认域名解析器',
    description: '当存在域名类出站且 route.default_domain_resolver 缺失时，按 1.14 新 DNS 处理注入默认解析器。'
  }
]

const initState = () => {
  window[Plugin.id] = window[Plugin.id] || {}
  if (!window[Plugin.id].settings) {
    window[Plugin.id].settings = Vue.ref(clone(DEFAULT_SETTINGS))
  }
  if (!window[Plugin.id].preview) {
    window[Plugin.id].preview = Vue.ref(createEmptyReport())
  }
  if (typeof window[Plugin.id].loaded !== 'boolean') {
    window[Plugin.id].loaded = false
  }
  return window[Plugin.id]
}

initState()

const getState = () => initState()

const ensureDataFile = async () => {
  if (!(await Plugins.FileExists('data/third').catch(() => false))) {
    await Plugins.MakeDir('data/third')
  }
  if (!(await Plugins.FileExists(DATA_DIR).catch(() => false))) {
    await Plugins.MakeDir(DATA_DIR)
  }
  if (!(await Plugins.FileExists(SETTINGS_FILE).catch(() => false))) {
    await Plugins.WriteFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2))
  }
}

const readSettings = async () => {
  await ensureDataFile()
  const content = await Plugins.ReadFile(SETTINGS_FILE).catch(() => '{}')
  try {
    return normalizeSettings(JSON.parse(content))
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

const saveSettings = async (settings) => {
  await ensureDataFile()
  await Plugins.WriteFile(SETTINGS_FILE, JSON.stringify(normalizeSettings(settings), null, 2))
}

const loadSettings = async () => {
  if (!getState().loaded) {
    getState().settings.value = await readSettings()
    getState().loaded = true
  }
  return getState().settings.value
}

const normalizeSettings = (settings) => ({
  enabled: settings?.enabled !== false,
  runMode: normalizeRunMode(settings?.runMode),
  manualKernelVersion: String(settings?.manualKernelVersion || '').trim(),
  notifyOnApply: settings?.notifyOnApply !== false,
  recommendationToggles: {
    ...DEFAULT_SETTINGS.recommendationToggles,
    ...(settings?.recommendationToggles || {})
  },
  featureToggles: {
    ...DEFAULT_SETTINGS.featureToggles,
    ...(settings?.featureToggles || {})
  }
})

const normalizeRunMode = (runMode) => {
  const value = String(runMode || '')
  if (['beta_only', 'always', 'preview_only'].includes(value)) return value
  return DEFAULT_SETTINGS.runMode
}

const onReady = async () => {
  await loadSettings()
}

const onRun = async () => {
  await openManager()
}

const onBeforeCoreStart = async (config) => {
  const settings = await loadSettings()
  if (!settings.enabled || settings.runMode === 'preview_only') return config
  const kernelInfo = await getKernelInfo(settings)
  const shouldApply = settings.runMode === 'always' || kernelInfo.isPrerelease
  if (!shouldApply) return config

  const report = applyMigrations(config, settings, { mutate: true, kernelInfo })
  getState().preview.value = report
  if (settings.notifyOnApply && report.totalApplied > 0) {
    Plugins.message.info(`测试版核心兼容转换已应用 ${report.totalApplied} 项`)
  }
  return config
}

const applyMigrations = (config, settings, options = {}) => {
  const workingConfig = options.mutate ? config : clone(config || {})
  const report = createEmptyReport()
  report.kernel = options.kernelInfo || {
    version: '',
    isPrerelease: false,
    source: ''
  }
  report.enabled = settings.enabled
  report.runMode = settings.runMode

  migrateLegacyDnsServers(workingConfig, report)
  migrateOutboundDnsRules(workingConfig, report)
  migrateTunRouteFields(workingConfig, report)

  if (settings.recommendationToggles.dnsCache) {
    migrateIndependentDnsCache(workingConfig, report)
  } else {
    recordSkipped(report, 'dns-cache')
  }
  if (settings.recommendationToggles.cacheFileStoreDns) {
    migrateStoreRdrc(workingConfig, report)
  } else {
    recordSkipped(report, 'cache-file-store-dns')
  }
  if (settings.recommendationToggles.directOverride) {
    migrateDirectOverrideFields(workingConfig, report)
  } else {
    recordSkipped(report, 'direct-override')
  }
  detectDnsResponseMatchNeeds(workingConfig, report, settings)
  detectInboundLegacyFields(workingConfig, report, settings)
  applyFeatureInjections(workingConfig, report, settings)

  report.totalApplied = getAppliedReportItems(report).reduce((total, item) => total + item.count, 0)
  return report
}

const migrateLegacyDnsServers = (config, report) => {
  if (!Array.isArray(config?.dns?.servers)) return
  let count = 0
  for (const server of config.dns.servers) {
    if (!server || typeof server !== 'object') continue
    if (server.type || !server.address) continue
    const address = String(server.address)
    const serverType = inferDnsServerType(address)
    if (!serverType) continue
    server.type = serverType
    if (['http3', 'https', 'tcp', 'udp', 'tls', 'quic'].includes(serverType)) {
      server.server = normalizeDnsServerHost(address)
    }
    delete server.address
    count += 1
  }
  recordForce(report, 'legacy-dns-server', count)
}

const inferDnsServerType = (address) => {
  const value = address.trim().toLowerCase()
  if (!value) return ''
  if (value === 'local') return 'local'
  if (value === 'fakeip' || value === 'fake-ip') return 'fakeip'
  if (value.startsWith('https://')) return 'https'
  if (value.startsWith('h3://')) return 'http3'
  if (value.startsWith('tls://')) return 'tls'
  if (value.startsWith('quic://')) return 'quic'
  if (value.startsWith('tcp://')) return 'tcp'
  if (value.startsWith('udp://')) return 'udp'
  if (isIpLikeHost(value)) return 'udp'
  return ''
}

const normalizeDnsServerHost = (address) => {
  const value = String(address || '').trim()
  if (!value) return ''
  if (!value.includes('://')) return value
  try {
    return new URL(value).hostname
  } catch {
    return value.replace(/^[a-z0-9+.-]+:\/\//i, '')
  }
}

const migrateOutboundDnsRules = (config, report) => {
  if (!Array.isArray(config?.dns?.rules)) return
  const rules = config.dns.rules
  const remainingRules = []
  let count = 0
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || !rule.outbound || !rule.server) {
      remainingRules.push(rule)
      continue
    }
    if (!isPureOutboundDnsRule(rule)) {
      remainingRules.push(rule)
      recordSkipped(report, 'outbound-dns-rule', 1, '复杂 outbound DNS 规则需要手动迁移。')
      continue
    }
    const resolver = buildDomainResolverFromDnsRule(rule)
    const outboundTags = expandOutboundRuleTargets(rule.outbound, config)
    if (outboundTags.length === 0) {
      if (!config.route) config.route = {}
      if (!config.route.default_domain_resolver) {
        config.route.default_domain_resolver = resolver
        count += 1
      }
      continue
    }
    let applied = 0
    for (const outbound of config.outbounds || []) {
      if (!outboundTags.includes(outbound.tag)) continue
      if (outbound.domain_resolver) continue
      outbound.domain_resolver = clone(resolver)
      applied += 1
    }
    count += applied
  }
  config.dns.rules = remainingRules
  recordForce(report, 'outbound-dns-rule', count)
}

const isPureOutboundDnsRule = (rule) => {
  const allowedKeys = new Set([
    'outbound',
    'server',
    'rewrite_ttl',
    'client_subnet',
    'disable_cache',
    'strategy',
    'timeout'
  ])
  return Object.keys(rule).every((key) => allowedKeys.has(key))
}

const buildDomainResolverFromDnsRule = (rule) => {
  const resolver = {
    server: rule.server
  }
  for (const key of ['rewrite_ttl', 'client_subnet', 'disable_cache', 'strategy', 'timeout']) {
    if (rule[key] !== undefined) resolver[key] = rule[key]
  }
  return Object.keys(resolver).length === 1 ? resolver.server : resolver
}

const expandOutboundRuleTargets = (outboundRule, config) => {
  const values = Array.isArray(outboundRule) ? outboundRule : [outboundRule]
  if (values.includes('any')) {
    return (config.outbounds || []).map((outbound) => outbound.tag).filter(Boolean)
  }
  return values.map((value) => String(value || '')).filter(Boolean)
}

const migrateTunRouteFields = (config, report) => {
  if (!Array.isArray(config?.inbounds)) return
  let count = 0
  for (const inbound of config.inbounds) {
    if (!inbound || inbound.type !== 'tun') continue
    count += mergeArrayField(inbound, 'route_address', ['inet4_route_address', 'inet6_route_address'])
    count += mergeArrayField(inbound, 'route_exclude_address', ['inet4_route_exclude_address', 'inet6_route_exclude_address'])
  }
  recordForce(report, 'tun-route-address', count)
}

const mergeArrayField = (target, nextKey, oldKeys) => {
  const values = []
  for (const key of oldKeys) {
    values.push(...toArray(target[key]))
  }
  if (values.length === 0) return 0
  target[nextKey] = unique(toArray(target[nextKey]).concat(values))
  oldKeys.forEach((key) => delete target[key])
  return 1
}

const migrateIndependentDnsCache = (config, report) => {
  if (!config?.dns || config.dns.independent_cache === undefined) return
  delete config.dns.independent_cache
  recordRecommend(report, 'dns-cache', 1)
}

const migrateStoreRdrc = (config, report) => {
  const cacheFile = config?.experimental?.cache_file
  if (!cacheFile || typeof cacheFile !== 'object' || cacheFile.store_rdrc === undefined) return
  if (cacheFile.store_dns === undefined) {
    cacheFile.store_dns = cacheFile.store_rdrc
  }
  delete cacheFile.store_rdrc
  recordRecommend(report, 'cache-file-store-dns', 1)
}

const migrateDirectOverrideFields = (config, report) => {
  if (!Array.isArray(config?.outbounds)) return
  let count = 0
  const routeRules = []
  for (const outbound of config.outbounds) {
    if (!outbound || outbound.type !== 'direct') continue
    if (outbound.override_address === undefined && outbound.override_port === undefined) continue
    const routeRule = {
      action: 'route-options'
    }
    if (outbound.tag) routeRule.outbound = outbound.tag
    if (outbound.override_address !== undefined) routeRule.override_address = outbound.override_address
    if (outbound.override_port !== undefined) routeRule.override_port = outbound.override_port
    routeRules.push(routeRule)
    delete outbound.override_address
    delete outbound.override_port
    count += 1
  }
  if (routeRules.length > 0) {
    if (!config.route) config.route = {}
    config.route.rules = routeRules.concat(config.route.rules || [])
  }
  recordRecommend(report, 'direct-override', count)
}

const detectDnsResponseMatchNeeds = (config, report, settings) => {
  const rules = config?.dns?.rules || []
  const count = rules.filter((rule) => rule && !rule.match_response && (
    rule.ip_cidr !== undefined ||
    rule.ip_is_private !== undefined ||
    rule.rule_set_ip_cidr_accept_empty !== undefined
  )).length
  if (count === 0) return
  if (settings.recommendationToggles.dnsResponseMatch) {
    recordRecommend(report, 'dns-response-match', count, '需要按规则语义手动迁移为 evaluate + match_response。')
  } else {
    recordSkipped(report, 'dns-response-match', count)
  }
}

const detectInboundLegacyFields = (config, report, settings) => {
  const inbounds = config?.inbounds || []
  const legacyKeys = ['sniff', 'sniff_override_destination', 'domain_strategy']
  const count = inbounds.filter((inbound) => legacyKeys.some((key) => inbound?.[key] !== undefined)).length
  if (count === 0) return
  if (settings.recommendationToggles.inboundLegacyFields) {
    recordRecommend(report, 'inbound-legacy-fields', count, '需要按入站语义手动迁移到 route/dns 规则动作。')
  } else {
    recordSkipped(report, 'inbound-legacy-fields', count)
  }
}

const applyFeatureInjections = (config, report, settings) => {
  if (settings.featureToggles.routeDefaultDomainResolver) {
    injectRouteDefaultDomainResolver(config, report)
  } else {
    recordSkipped(report, 'route-default-domain-resolver')
  }
}

const injectRouteDefaultDomainResolver = (config, report) => {
  if (!hasDomainOutboundWithoutResolver(config)) return
  if (!config.route) config.route = {}
  if (config.route.default_domain_resolver !== undefined) return

  const resolver = findDefaultDomainResolver(config)
  if (resolver === undefined) return
  config.route.default_domain_resolver = resolver
  recordInjected(report, 'route-default-domain-resolver', 1, `使用 ${formatResolverLabel(resolver)}`)
}

const hasDomainOutboundWithoutResolver = (config) => {
  return (config?.outbounds || []).some((outbound) => {
    if (!outbound || typeof outbound !== 'object') return false
    if (outbound.domain_resolver !== undefined) return false
    return isDomainHost(outbound.server) || isDomainHost(outbound.address)
  })
}

const findDefaultDomainResolver = (config) => {
  if (config?.dns?.final) return config.dns.final
  const servers = config?.dns?.servers || []
  const taggedServers = servers
    .map((server) => server?.tag)
    .filter((tag) => typeof tag === 'string' && tag.trim())
  if (taggedServers.length === 1) return taggedServers[0]
  return undefined
}

const formatResolverLabel = (resolver) => {
  if (typeof resolver === 'string') return resolver
  if (resolver && typeof resolver === 'object' && resolver.server) return resolver.server
  return '默认解析器'
}

const openManager = async () => {
  const { ref, h } = Vue
  const settings = ref(normalizeSettings(await loadSettings()))
  const preview = ref(await buildPreview(settings.value))

  const component = {
    template: `
    <div class="flex flex-col gap-10 pr-8">
      <div class="flex items-center justify-between gap-8">
        <div class="min-w-0">
          <div class="font-bold text-16">测试版核心配置迁移 <span class="text-12 opacity-70">{{ pluginVersion }}</span></div>
          <div class="text-12 opacity-70 truncate" :title="summaryText">{{ summaryText }}</div>
        </div>
        <div class="flex gap-8">
          <Button @click="refreshPreview">刷新预览</Button>
          <Button type="primary" @click="save">保存</Button>
        </div>
      </div>

      <Card>
        <div class="grid items-center gap-8" style="grid-template-columns: 140px minmax(180px, 1fr) 140px minmax(160px, 1fr);">
          <div class="font-bold text-13">启用插件</div>
          <Switch v-model="settings.enabled">启用</Switch>
          <div class="font-bold text-13">运行模式</div>
          <select v-model="settings.runMode" class="gfs-native-input">
            <option v-for="option in runModes" :key="getOptionValue(option)" :value="getOptionValue(option)">
              {{ getOptionLabel(option) }}
            </option>
          </select>
          <div class="font-bold text-13">应用时通知</div>
          <Switch v-model="settings.notifyOnApply">启用</Switch>
          <div class="font-bold text-13">检测到的核心</div>
          <div class="text-12 opacity-75" style="word-break: break-word;">{{ kernelText }}</div>
          <div class="font-bold text-13">手动核心版本</div>
          <Input v-model="settings.manualKernelVersion" placeholder="例如 1.14.0-alpha.33，可空" allow-paste />
          <div class="font-bold text-13">检测来源</div>
          <div class="text-12 opacity-75" style="word-break: break-word;">{{ kernelSourceText }}</div>
        </div>
      </Card>

      <Card>
        <div class="font-bold text-14 mb-8">强制类转换</div>
        <div class="grid gap-8" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));">
          <div v-for="item in forceItems" :key="item.id" class="rounded-4 p-8" style="border: 1px solid #cbd5e1; background: #f8fafc;">
            <div class="font-bold text-13">{{ item.title }}</div>
            <div class="text-12 opacity-75 mt-4">{{ item.description }}</div>
            <div class="text-12 mt-6" style="color: #166534;">预览命中 {{ getReportCount(item.id) }} 项</div>
          </div>
        </div>
      </Card>

      <Card>
        <div class="font-bold text-14 mb-8">推荐类转换</div>
        <div class="grid gap-8" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
          <div v-for="item in recommendItems" :key="item.id" class="rounded-4 p-8" style="border: 1px solid #cbd5e1; background: #f8fafc;">
            <div class="flex items-start justify-between gap-8">
              <div class="min-w-0">
                <div class="font-bold text-13">{{ item.title }}</div>
                <div class="text-12 opacity-75 mt-4">{{ item.description }}</div>
              </div>
              <Switch v-model="settings.recommendationToggles[item.toggleKey]">启用</Switch>
            </div>
            <div class="text-12 mt-6" style="color: #166534;">预览命中 {{ getReportCount(item.id) }} 项</div>
          </div>
        </div>
      </Card>

      <Card>
        <div class="font-bold text-14 mb-8">功能注入</div>
        <div class="grid gap-8" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
          <div v-for="item in featureItems" :key="item.id" class="rounded-4 p-8" style="border: 1px solid #cbd5e1; background: #f8fafc;">
            <div class="flex items-start justify-between gap-8">
              <div class="min-w-0">
                <div class="font-bold text-13">{{ item.title }}</div>
                <div class="text-12 opacity-75 mt-4">{{ item.description }}</div>
              </div>
              <Switch v-model="settings.featureToggles[item.toggleKey]">启用</Switch>
            </div>
            <div class="text-12 mt-6" style="color: #166534;">预览命中 {{ getReportCount(item.id) }} 项</div>
          </div>
        </div>
      </Card>

      <Card>
        <div class="font-bold text-14 mb-8">最近预览结果</div>
        <div class="grid gap-8" style="grid-template-columns: 1fr 1fr;">
          <div>
            <div class="font-bold text-13 mb-4">已转换</div>
            <div v-for="item in appliedReportItems" :key="item.id" class="text-12 leading-6">
              {{ item.title }}：{{ item.count }} 项<span v-if="item.note">，{{ item.note }}</span>
            </div>
            <div v-if="appliedReportItems.length === 0" class="text-12 opacity-70">无</div>
          </div>
          <div>
            <div class="font-bold text-13 mb-4">跳过 / 需要手动处理</div>
            <div v-for="item in skippedReportItems" :key="item.id" class="text-12 leading-6">
              {{ item.title }}：{{ item.count }} 项
            </div>
            <div v-if="skippedReportItems.length === 0" class="text-12 opacity-70">无</div>
          </div>
        </div>
      </Card>
    </div>
    `,
    setup() {
      const getOptionLabel = (option) => String(option).split(',')[0]
      const getOptionValue = (option) => String(option).split(',')[1]
      const refreshPreview = async () => {
        preview.value = await buildPreview(settings.value)
        getState().preview.value = preview.value
      }
      const save = async () => {
        const normalized = normalizeSettings(settings.value)
        getState().settings.value = normalized
        await saveSettings(normalized)
        preview.value = await buildPreview(normalized)
        getState().preview.value = preview.value
        Plugins.message.success('测试版核心配置迁移设置已保存')
        modal.close()
      }

      return {
        pluginVersion: Plugin.version || '',
        settings,
        preview,
        runModes: RUN_MODES,
        forceItems: CONVERSION_DEFINITIONS.filter((item) => item.level === 'force'),
        recommendItems: CONVERSION_DEFINITIONS.filter((item) => item.level === 'recommend').map((item) => ({
          ...item,
          toggleKey: getToggleKey(item.id)
        })),
        featureItems: FEATURE_DEFINITIONS.map((item) => ({
          ...item,
          toggleKey: getToggleKey(item.id)
        })),
        summaryText: Vue.computed(() => `预览配置：${preview.value.profileName || '未找到'}，命中 ${preview.value.totalDetected || 0} 项`),
        kernelText: Vue.computed(() => preview.value.kernel.version || '未检测到核心版本'),
        kernelSourceText: Vue.computed(() => preview.value.kernel.source || '无'),
        appliedReportItems: Vue.computed(() => getAppliedReportItems(preview.value)),
        skippedReportItems: Vue.computed(() => preview.value.skipped),
        getReportCount: (id) => getReportCount(preview.value, id),
        getOptionLabel,
        getOptionValue,
        refreshPreview,
        save
      }
    }
  }

  const modal = Plugins.modal(
    {
      title: '测试版核心配置迁移',
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

const buildPreview = async (settings) => {
  const profile = getCurrentProfile()
  if (!profile) {
    return createEmptyReport()
  }
  const generatedConfig = await Plugins.generateConfig(profile, { enablePluginProcessing: false }).catch(() => null)
  const normalizedSettings = normalizeSettings(settings)
  const kernelInfo = await getKernelInfo(normalizedSettings)
  const report = applyMigrations(generatedConfig || {}, normalizedSettings, { mutate: false, kernelInfo })
  report.profileName = profile.name || ''
  report.totalDetected = getAppliedReportItems(report).concat(report.skipped).reduce((total, item) => total + item.count, 0)
  return report
}

const getCurrentProfile = () => {
  const profilesStore = Plugins.useProfilesStore()
  const appSettingsStore = Plugins.useAppSettingsStore()
  const profiles = profilesStore.profiles || []
  const currentProfileId = appSettingsStore.app?.kernel?.profile
  return profiles.find((profile) => profile.id === currentProfileId) || profilesStore.currentProfile || profiles[0]
}

const getKernelInfo = async (settings = {}) => {
  const manualVersion = String(settings.manualKernelVersion || '').trim()
  if (manualVersion) {
    return {
      version: manualVersion,
      isPrerelease: isPrereleaseVersion(manualVersion),
      source: '手动填写'
    }
  }

  const realVersion = await getKernelVersionByExec()
  if (realVersion) {
    return {
      version: realVersion,
      isPrerelease: isPrereleaseVersion(realVersion),
      source: '核心执行结果'
    }
  }

  const sources = []
  for (const getter of [Plugins.useKernelApiStore, Plugins.useAppSettingsStore, Plugins.useEnvStore]) {
    try {
      sources.push(getter())
    } catch {}
  }
  const matched = findKernelVersionCandidate(sources)
  return {
    version: matched.version,
    isPrerelease: isPrereleaseVersion(matched.version),
    source: matched.source
  }
}

const getKernelVersionByExec = async () => {
  try {
    const appSettingsStore = Plugins.useAppSettingsStore()
    const branch = appSettingsStore.app?.kernel?.branch
    const kernelFileName = await Plugins.getKernelFileName(branch !== 'main')
    const kernelFilePath = await Plugins.AbsolutePath('data/sing-box/' + kernelFileName)
    const output = await Plugins.Exec(kernelFilePath, ['version'])
    return parseSingBoxVersion(output)
  } catch {
    return ''
  }
}

const parseSingBoxVersion = (output) => {
  const firstLine = String(output || '').split('\n')[0] || ''
  const matched = firstLine.match(/(?:sing-box\s+version\s+)?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/i)
  return matched?.[1] || ''
}

const findKernelVersionCandidate = (values) => {
  const seen = new Set()
  const stack = [].concat(values || []).map((value, index) => ({
    value,
    path: `store${index}`
  }))
  const candidates = []
  while (stack.length > 0 && seen.size < 800) {
    const item = stack.shift()
    const value = item.value
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      if (isKernelPath(item.path) && isVersionCandidate(value)) {
        candidates.push({
          version: value,
          source: item.path
        })
      }
      continue
    }
    if (typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${item.path}.${key}`
      if (typeof child === 'string') {
        if (isKernelPath(childPath) && isVersionCandidate(child)) {
          candidates.push({
            version: child,
            source: childPath
          })
        }
        continue
      }
      if (child && typeof child === 'object' && isPotentialKernelPath(childPath)) {
        stack.push({
          value: child,
          path: childPath
        })
      }
    }
  }
  return selectVersionCandidate(candidates)
}

const isKernelPath = (path) => {
  return /(?:kernel|core|sing.?box|singbox)/i.test(path) && /(?:version|name|path|core|kernel|sing.?box|singbox)/i.test(path)
}

const isPotentialKernelPath = (path) => {
  return /(?:^store\d+$|\.app$|\.env$|kernel|core|sing.?box|singbox)/i.test(path)
}

const isPrereleaseVersion = (version) => /(?:alpha|beta|rc|testing|nightly|dev)/i.test(String(version || ''))

const isVersionCandidate = (value) => {
  return /alpha|beta|rc|testing|nightly|dev|\d+\.\d+\.\d+/i.test(String(value || ''))
}

const selectVersionCandidate = (candidates) => {
  const uniqueCandidates = []
  const seen = new Set()
  for (const candidate of candidates) {
    const version = String(candidate.version || '').trim()
    if (!version || seen.has(version)) continue
    seen.add(version)
    uniqueCandidates.push({
      version,
      source: candidate.source || '自动检测'
    })
  }
  return uniqueCandidates.find((candidate) => isPrereleaseVersion(candidate.version)) ||
    uniqueCandidates.find((candidate) => /\d+\.\d+\.\d+/.test(candidate.version)) ||
    uniqueCandidates[0] ||
    {
      version: '',
      source: ''
    }
}

const getToggleKey = (id) => ({
  'dns-cache': 'dnsCache',
  'cache-file-store-dns': 'cacheFileStoreDns',
  'direct-override': 'directOverride',
  'dns-response-match': 'dnsResponseMatch',
  'inbound-legacy-fields': 'inboundLegacyFields',
  'route-default-domain-resolver': 'routeDefaultDomainResolver'
})[id]

const getAppliedReportItems = (report) => {
  return toArray(report?.force).concat(toArray(report?.recommend), toArray(report?.inject))
}

const getReportCount = (report, id) => {
  const item = getAppliedReportItems(report)
    .concat(toArray(report?.skipped))
    .find((entry) => entry?.id === id)
  return item?.count || 0
}

const recordForce = (report, id, count, note = '') => recordReportItem(report.force, id, count, note)

const recordRecommend = (report, id, count, note = '') => recordReportItem(report.recommend, id, count, note)

const recordInjected = (report, id, count, note = '') => recordReportItem(report.inject, id, count, note)

const recordSkipped = (report, id, count = 0, note = '') => {
  if (count > 0) recordReportItem(report.skipped, id, count, note)
}

const recordReportItem = (items, id, count, note = '') => {
  if (!count) return
  const definition = CONVERSION_DEFINITIONS.concat(FEATURE_DEFINITIONS).find((item) => item.id === id)
  items.push({
    id,
    title: definition?.title || id,
    count,
    note
  })
}

function createEmptyReport() {
  return {
    profileName: '',
    enabled: true,
    runMode: DEFAULT_SETTINGS.runMode,
    kernel: {
      version: '',
      isPrerelease: false
    },
    force: [],
    recommend: [],
    inject: [],
    skipped: [],
    totalApplied: 0,
    totalDetected: 0
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function unique(items) {
  return Array.from(new Set(items.filter((item) => item !== undefined && item !== null && item !== '')))
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isIpLikeHost(value) {
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value) || /^\[[0-9a-f:]+](:\d+)?$/i.test(value)
}

function isDomainHost(value) {
  const host = String(value || '').trim()
  if (!host) return false
  if (isIpLikeHost(host)) return false
  return /[a-z]/i.test(host)
}

export default {
  onReady,
  onRun,
  onBeforeCoreStart
}
