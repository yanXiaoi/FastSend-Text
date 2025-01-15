<script setup lang="ts">
import CryptoJS from 'crypto-js'
import { PeerDataChannel } from '~/utils/PeerDataChannel'

const { t } = useI18n()
const localePath = useLocalePath()
const isModernFileAPISupport = ref(true)
const toast = useToast()
const router = useRouter()
const userInfo = useUserInfo()
const peerUserInfo = ref({ nickname: 'unknown', avatarURL: '' })
const peerFilesInfo = ref<any>({ type: '', fileMap: {} })
const selectedKeys = ref({})
const code = ref('')
const waitReceiveFileList = ref<string[]>([])
const transmittedCount = ref(0)
const receiveFileIndex = ref(0)
const totalFileSize = ref(0)
const totalTransmittedBytes = ref(0)
const startTime = ref(0)
const totalSpeed = ref(0)
const durationTimeStr = ref('00:00') //computed(() => formatTime(new Date().getTime() - startTime.value))
const remainingTimeStr = ref('00:00')
const hasher = CryptoJS.algo.MD5.create()
const curFile = ref<any>({
  name: '',
  size: 0,
  transmittedBytes: 0,
  lastBytes: 0,
  speed: 0,
  chunks: []
})
const status = ref({
  isConnectServer: false,
  isConnectPeer: false,
  isPeerConnecting: false,
  isIniting: true,
  isWaitingPeerConfirm: true,
  isLock: false,
  isReceiving: false,
  isDone: false,
  error: {
    code: 0,
    msg: ''
  },
  warn: {
    code: 0,
    msg: ''
  }
})
const syncDirStatus = ref<any>({
  folderName: '',
  isWaitingSelectDir: true,
  isDiffing: true,
  fileMapAdd: {},
  fileMapUpdate: {},
  fileMapDelete: {},
  waitAddList: [],
  waitUpdateList: [],
  waitDeleteList: []
})

let calcSpeedJobId: any
let ws: WebSocket | null
let pdc: PeerDataChannel | null
let saveFileFH: FileSystemFileHandle | undefined
let curFileWriter: FileSystemWritableFileStream | undefined
let rootDirDH: FileSystemDirectoryHandle | undefined
let syncTargetDH: FileSystemDirectoryHandle | undefined
let reqFileResolveFn: () => void | undefined
let reqFileRejecteFn: () => void | undefined
let calcPeerFileHashResolveFn: (hash: string) => void | undefined
let calcPeerFileHashRejecteFn: () => void | undefined

useSeoMeta({
  title: t('recipient')
})

// 关闭连接并清理资源
function dispose() {
  console.log('dispose')

  clearInterval(calcSpeedJobId)
  if (reqFileRejecteFn) {
    reqFileRejecteFn()
  }
  if (calcPeerFileHashRejecteFn) {
    calcPeerFileHashRejecteFn()
  }
  ws?.close()
  pdc?.dispose()
}

// 计算传输速度和用时
function calcSpeedFn() {
  const curBytes = curFile.value.transmittedBytes + (pdc?.getReceivedBufferSize() || 0)
  curFile.value.speed = curBytes - curFile.value.lastSize
  curFile.value.lastSize = curBytes
  totalSpeed.value = totalTransmittedBytes.value / ((new Date().getTime() - startTime.value) / 1e3)
  durationTimeStr.value = formatTime(new Date().getTime() - startTime.value)
  remainingTimeStr.value = formatTime(
    ((totalFileSize.value - totalTransmittedBytes.value) / totalSpeed.value) * 1e3
  )
}

// 对于不支持现代文件访问API的备用下载方法
function downloadFile() {
  doDownloadFromBlob(new Blob(curFile.value.chunks), curFile.value.name)
}

// 处理文件数据块
async function handleBufferData(buf: ArrayBuffer) {
  curFile.value.transmittedBytes += buf.byteLength
  totalTransmittedBytes.value += buf.byteLength
  hasher.update(CryptoJS.lib.WordArray.create(buf))
  if (isModernFileAPISupport.value) {
    // 支持现代文件访问API，直接写到文件
    await curFileWriter?.write(buf)
    if (curFile.value.transmittedBytes === curFile.value.size) {
      // 该文件传输完毕
      await curFileWriter?.close()
    }
  } else {
    // 不支持现代文件访问，放到内存中
    curFile.value.chunks.push(buf)
  }
}

// 初始化当前文件状态
function initCurFile(key?: string) {
  const fm = peerFilesInfo.value.fileMap
  let fileName
  if (key) {
    fileName = key
    if (!fm[key]) {
      throw new Error('File not found')
    }
  } else {
    const fileNames = Object.keys(fm)
    if (fileNames.length === 0) {
      throw new Error('File not found')
    }
    fileName = fileNames[0]
  }

  curFile.value = {
    name: fileName,
    size: fm[fileName]?.size || 0,
    transmittedBytes: 0,
    lastSize: 0,
    speed: 0,
    chunks: []
  }
}

// 处理JSON数据对象
async function handleObjData(obj: any) {
  // console.log(obj)
  if (obj.type === 'user') {
    // 用户信息
    peerUserInfo.value = obj.data
  } else if (obj.type === 'files') {
    // 文件信息
    peerFilesInfo.value = obj.data
    if (peerFilesInfo.value.type === 'transFile') {
      // 传输单个文件
      initCurFile()
      totalFileSize.value = curFile.value.size
    }else if (peerFilesInfo.value.type === 'transText'){
        //对话框显示文本
        toast.add({
          severity: 'success',
          summary: 'Success',
          detail: '接收完毕',
          life: 5e3
        })
        /// 传输完成，告知对方
        await pdc?.sendData(JSON.stringify({ type: 'done' }))
        status.value.isReceiving = false
        status.value.isDone = true
        dispose()
    }else {
      if (!isModernFileAPISupport.value) {
        // 传输目录，但是不支持现代文件访问API，直接报错
        status.value.warn.code = -1
        status.value.warn.msg = '不支持目录传输'
        // 告知对方情况
        await pdc?.sendData(JSON.stringify({ type: 'err', data: -1 }))
        dispose()
      } else if (peerFilesInfo.value.type === 'syncDir') {
        // 目录同步
        syncDirStatus.value.folderName = peerFilesInfo.value.root
      }
    }
    status.value.isWaitingPeerConfirm = false
  } else if (obj.type === 'fileDone') {
    // 收到文件HASH
    const hash = hasher.finalize().toString(CryptoJS.enc.Base64)
    if (hash !== obj.data) {
      // Hash匹配失败
      console.error(
        'Hash check failure.',
        curFile.value.name,
        'send:',
        obj.data,
        'receive:',
        CryptoJS.enc.Base64.parse(hash).toString(CryptoJS.enc.Hex)
      )
      status.value.warn.code = -3
      toast.add({
        severity: 'error',
        summary: 'Error',
        detail: t('hint.hashCheckFail'),
        life: 5e3
      })
      if (saveFileFH) {
        // 删除传输失败的文件
        saveFileFH.remove()
      }
      dispose()
      return
    } else {
      console.log(
        'Hash check successful.',
        curFile.value.name,
        CryptoJS.enc.Base64.parse(hash).toString(CryptoJS.enc.Hex)
      )
    }

    if (reqFileResolveFn) {
      // 文件传输完毕
      reqFileResolveFn()
    }

    if (!isModernFileAPISupport.value) {
      // 如果不支持文件访问API，则直接触发下载
      downloadFile()
    }
  } else if (obj.type === 'fileHash') {
    if (calcPeerFileHashResolveFn) {
      calcPeerFileHashResolveFn(obj.data)
    }
  } else if (obj.type === 'err') {
    console.warn(obj.data)
    if (obj.data === 403) {
      // 用户拒绝传输
      status.value.error.code = 403
      status.value.error.msg = '用户拒绝传输'
      toast.add({
        severity: 'error',
        summary: 'Error',
        detail: t('hint.refusesToTransmit'),
        life: 5e3
      })
    } else if (obj.data === 404) {
      // 找不到对应的文件
      toast.add({ severity: 'warn', summary: 'Warn', detail: '文件找不到', life: 3e3 })
    }
    // toast.add({ severity: 'warn', summary: 'Warn', detail: obj.data, life: 3e3 })
  }
}

// 初始化对等数据通道
function initPDC() {
  status.value.isPeerConnecting = true
  pdc = new PeerDataChannel({ iceServers: pubIceServers, initializeDataChannel: true })
  pdc.onSDP = (sdp) => ws?.send(JSON.stringify({ type: 'sdp', data: sdp }))
  pdc.onICECandidate = (candidate) =>
    ws?.send(JSON.stringify({ type: 'candidate', data: candidate }))
  pdc.onDispose = () => {
    status.value.isConnectPeer = false
    if (status.value.isIniting) {
      // 尝试连接失败（超时）
      status.value.error.code = -10
    } else if (status.value.isWaitingPeerConfirm) {
      status.value.error.code = 403
    } else if (status.value.isReceiving) {
      status.value.warn.code = -2
      status.value.warn.msg = '连接断开，传输失败'
    }
    dispose()
    toast.add({ severity: 'warn', summary: 'Warn', detail: 'Disconnected', life: 5000 })
  }
  pdc.onError = (err) => {
    console.error(err)
    status.value.isConnectPeer = false
    status.value.isPeerConnecting = false
    if (status.value.isIniting) {
      status.value.error.code = 500
      status.value.error.msg = err + ''
    }
    dispose()
    toast.add({ severity: 'error', summary: 'Error', detail: err + '', life: 5000 })
  }
  pdc.onConnected = () => {
    status.value.isConnectPeer = true
    status.value.isPeerConnecting = false
    status.value.isIniting = false
  }
  pdc.onOpen = () => pdc?.sendData(JSON.stringify({ type: 'user', data: userInfo.value }))
  pdc.onReceive = async (data) => {
    // console.log('data', data)
    if (typeof data === 'string') {
      await handleObjData(JSON.parse(data))
    } else {
      await handleBufferData(data)
    }
  }
}

// 请求文件
async function requestFile(key: string) {
  return new Promise<void>((resolve, reject) => {
    reqFileResolveFn = resolve
    reqFileRejecteFn = reject
    hasher.reset()
    pdc?.sendData(JSON.stringify({ type: 'reqFile', data: key }))
  })
}

// 计算对面文件哈希
async function calcPeerFileHash(key: string) {
  return new Promise<string>((resolve, reject) => {
    calcPeerFileHashResolveFn = resolve
    calcPeerFileHashRejecteFn = reject
    pdc?.sendData(JSON.stringify({ type: 'calcFileHash', data: key }))
  })
}

// 选择要接收同步的目录
function selectSyncDir() {
  showDirectoryPicker()
    .then((dh: FileSystemDirectoryHandle) => {
      syncDirStatus.value.isWaitingSelectDir = false
      syncTargetDH = dh
      return dealFilesFromHandler(dh)
    })
    .then((val: any) => fileMapRemoveRoot(val))
    .then(async (localFileMap: any) => {
      syncDirStatus.value.isDiffing = true
      // 开始对比目录结构
      for (let k in peerFilesInfo.value.fileMap) {
        if (k in localFileMap) {
          console.log(peerFilesInfo.value.fileMap[k]?.size, localFileMap[k]?.size)

          if (peerFilesInfo.value.fileMap[k]?.size === localFileMap[k]?.size) {
            // 大小相等，根据情况进一步计算哈希
            const peerHashPromise = calcPeerFileHash(k)
            const localFileHash = await calcMD5(localFileMap[k].file)
            const peerFileHash = await peerHashPromise
            console.log('localFileHash', localFileHash)
            console.log('peerFileHash', peerFileHash)
            if (localFileHash === peerFileHash) {
              localFileMap[k]['isEqual'] = true
              continue
            }
          }
          // 要更新的
          syncDirStatus.value.fileMapUpdate[k] = localFileMap[k]
          localFileMap[k]['isUpdate'] = true
        } else {
          // 要新增的
          syncDirStatus.value.fileMapAdd[k] = peerFilesInfo.value.fileMap[k]
        }
      }
      for (let k in localFileMap) {
        if (!localFileMap[k]['isUpdate'] && !localFileMap[k]['isEqual']) {
          // 要删除的
          syncDirStatus.value.fileMapDelete[k] = localFileMap[k]
        }
      }
      syncDirStatus.value.isDiffing = false

      console.log(localFileMap)
      console.log(peerFilesInfo.value)
      console.log(syncDirStatus.value)
    })
    .catch((e: any) => {
      console.warn(e)
    })
}

// 开始接收
async function doReceive() {
  if (status.value.isReceiving) {
    return
  }
  status.value.isReceiving = true

  if (peerFilesInfo.value.type === 'transDir') {
    // 如果传输目录，则至少要选择一个文件
    waitReceiveFileList.value = Object.keys(selectedKeys.value).filter((n) => !/\/$/.test(n))
    if (waitReceiveFileList.value.length === 0) {
      toast.add({ severity: 'warn', summary: 'Warn', detail: '请至少选择一个文件', life: 3e3 })
      status.value.isReceiving = false
      return
    }
    totalFileSize.value = 0
    waitReceiveFileList.value.forEach((name) => {
      totalFileSize.value += peerFilesInfo.value.fileMap[name]?.size
    })
  } else if (peerFilesInfo.value.type === 'syncDir') {
    // 目录同步
    if (
      syncDirStatus.value.waitAddList.length === 0 ||
      syncDirStatus.value.waitUpdateList.length === 0 ||
      syncDirStatus.value.waitDeleteList.length === 0
    ) {
      toast.add({ severity: 'warn', summary: 'Warn', detail: '请至少选择一个文件', life: 3e3 })
      status.value.isReceiving = false
      return
    }
    // todo
  }
  status.value.isLock = true

  // 初始化参数
  receiveFileIndex.value = 0
  totalTransmittedBytes.value = 0
  // 启动传输速度计算定时器
  // startTime.value = Date.now()
  // calcSpeedJobId = setInterval(calcSpeedFn, 1e3)

  try {
    if (peerFilesInfo.value.type === 'transFile') {
      // 传输单个文件
      if (isModernFileAPISupport.value) {
        saveFileFH = await showSaveFilePicker({
          startIn: 'downloads',
          suggestedName: curFile.value.name
        })
        curFileWriter = await saveFileFH?.createWritable()
      }
      // 启动传输速度计算定时器
      startTime.value = Date.now()
      calcSpeedJobId = setInterval(calcSpeedFn, 1e3)
      await requestFile(curFile.value.name)
    } else if (peerFilesInfo.value.type === 'transDir') {
      // 传输目录
      rootDirDH = await showDirectoryPicker()
      // 启动传输速度计算定时器
      startTime.value = Date.now()
      calcSpeedJobId = setInterval(calcSpeedFn, 1e3)
      // console.log(waitReceiveFileList.value);
      for (let i = 0; i < waitReceiveFileList.value.length; i++) {
        const key = waitReceiveFileList.value[i]
        const paths = key.split('/')
        // console.log(paths)

        initCurFile(key)
        let curFolder = rootDirDH
        for (let j = 0; j < paths.length - 1; j++) {
          // console.log(curFolder)
          curFolder = await curFolder?.getDirectoryHandle(paths[j], { create: true })
        }
        // console.log(curFolder)

        const curFH = await curFolder?.getFileHandle(paths[paths.length - 1], { create: true })
        curFileWriter = await curFH?.createWritable()
        await requestFile(key)
      }
    } else if (peerFilesInfo.value.type === 'syncDir') {
      console.log('do sync dir')
    }

    // 传输完成，告知对方
    await pdc?.sendData(JSON.stringify({ type: 'done' }))
    status.value.isReceiving = false
    status.value.isDone = true
    calcSpeedFn()
    dispose()
    toast.add({
      severity: 'success',
      summary: 'Success',
      detail: t('hint.transCompleted'),
      life: 5e3
    })
  } catch (e) {
    console.warn(e)
    clearInterval(calcSpeedJobId)
    toast.add({ severity: 'error', summary: 'Error', detail: e, life: 5e3 })
    status.value.isLock = status.value.isReceiving = false
  }
}

onMounted(() => {
  isModernFileAPISupport.value = isModernFileAPIAvailable()
  const query = router.currentRoute.value.query
  if (!query.code) {
    router.replace(localePath('/'))
    return
  }
  code.value = query.code + ''

  // 初始化信令服务器连接WebSocker
  ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/connect')
  ws.onopen = () => {
    status.value.isConnectServer = true
    ws?.send(JSON.stringify({ type: 'receive', code: code.value }))
    // 超时处理
    setTimeout(() => {
      if (status.value.isIniting) {
        // 45秒后如果还没有连接成功，算超时
        dispose()
        if (status.value.error.code === 0) {
          status.value.error.code = -10
        }
      }
    }, 45e3)
  }
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.type === 'status') {
      if (data.code === 404) {
        status.value.error.code = 404
        status.value.error.msg = '404'
        dispose()
      } else if (data.code === 0) {
        initPDC()
      }
    } else if (data.type === 'sdp') {
      pdc?.setRemoteSDP(data.data)
    } else if (data.type === 'candidate') {
      pdc?.addICECandidate(data.data)
    }
  }
  ws.onclose = () => {
    status.value.isConnectServer = false
  }
  ws.onerror = (err) => {
    console.error(err)
    status.value.isConnectServer = false
  }
  useFullScreenLoader(false)
})

onUnmounted(() => {
  dispose()
})
</script>

<template>
  <div class="pb-8">
    <!-- 错误界面 -->
    <div v-if="status.error.code !== 0" class="py-16">
      <!-- 取件码无效 -->
      <div v-if="status.error.code === 404" class="text-center">
        <Icon
          name="solar:folder-error-linear"
          size="100"
          class="text-rose-500 dark:text-rose-600"
        />
        <p class="text-xl tracking-wider py-8">{{ $t('hint.invalidPickupCode') }}</p>
      </div>
      <!-- 对方拒绝传输 -->
      <div v-else-if="status.error.code === 403" class="text-center">
        <Icon
          name="solar:close-square-linear"
          size="100"
          class="text-rose-500 dark:text-rose-600"
        />
        <p class="text-xl tracking-wider py-8">{{ $t('hint.refusesToTransmit') }}</p>
      </div>
      <!-- 连接超时 -->
      <div v-else-if="status.error.code === -10" class="text-center">
        <Icon
          name="material-symbols:timer-off-outline-rounded"
          size="100"
          class="text-rose-500 dark:text-rose-600"
        />
        <p class="text-xl tracking-wider py-8">{{ $t('hint.connectTimeout') }}</p>
      </div>
      <!-- 其他错误 -->
      <div v-else class="text-center">
        <Icon name="solar:sad-square-line-duotone" size="100" />
        <p class="text-xl tracking-wider pt-8">{{ $t('hint.serverError') }}</p>
        <p class="text-sm tracking-wider pb-8 mt-2">({{ $t('hint.closeTheProxy') }})</p>
      </div>

      <div class="text-center my-4">
        <NuxtLink :to="localePath('/')">
          <Button severity="contrast" class="tracking-wider"
            ><Icon name="solar:home-2-linear" class="mr-2" />{{ $t('btn.toHome') }}</Button
          ></NuxtLink
        >
      </div>
    </div>

    <!-- 加载页面 -->
    <div v-else-if="status.isIniting" class="flex flex-col gap-4 items-center justify-center py-20">
      <div class="loader"></div>
      <p class="text-xs tracking-wide">{{ $t('hint.connecting') }}</p>
    </div>

    <!-- 等待对方确认 -->
    <div
      v-else-if="status.isWaitingPeerConfirm"
      class="flex flex-col gap-4 items-center justify-center py-20"
    >
      <div class="loader2"></div>
      <p class="text-sm tracking-wide mt-2">{{ $t('hint.waitingForConfirm') }}</p>
    </div>

    <!-- 连接成功页面 -->
    <div v-else class="md:grid md:grid-cols-2 md:gap-8 px-4 md:px-[10vw]">
      <!-- 用户和文件展示 -->
      <div>
        <!-- 发送方用户 -->
        <div
          class="p-2 pr-3 md:p-3 md:pr-5 shadow shadow-black/20 dark:bg-neutral-900 rounded-full flex flex-row items-center"
        >
          <Avatar
            :image="peerUserInfo.avatarURL"
            shape="circle"
            size="large"
            class="shadow shadow-black/15"
          />
          <span class="ml-3 text-base flex-1">{{ peerUserInfo.nickname }}</span>

          <Icon
            v-if="status.isConnectPeer"
            name="solar:link-round-angle-bold"
            class="text-green-500"
            size="20"
          />
          <Icon
            v-else
            name="solar:link-broken-minimalistic-broken"
            class="text-red-500"
            size="20"
          />
        </div>

        <!-- 文件列表 -->
        <div class="mt-4 md:mt-6">
          <!-- 单个文件 -->
          <div v-if="peerFilesInfo.type === 'transFile'" class="flex flex-col items-center mt-8">
            <Icon name="material-symbols-light:unknown-document-outline-rounded" size="64" />
            <p class="text-lg">{{ curFile.name }}</p>
            <p class="text-xs mt-1 text-gray-600 dark:text-gray-500">
              {{ humanFileSize(curFile.size) }}
            </p>
          </div>
          <!-- 目录 -->
          <FilesTree
            v-else-if="peerFilesInfo.type === 'transDir'"
            :file-map="peerFilesInfo.fileMap"
            :disabled="status.isLock"
            v-model:selected-key="selectedKeys"
          />
          <!-- 同步目录 -->
          <div v-else-if="peerFilesInfo.type === 'syncDir'">
            <!-- 选择要同步的目录 -->
            <div v-if="syncDirStatus.isWaitingSelectDir">
              <div class="flex flex-col items-center my-8">
                <Icon name="solar:folder-with-files-line-duotone" size="64" />
                <p class="text-lg mt-2">{{ syncDirStatus.folderName }}</p>
                <!-- <p class="text-xs mt-1 text-gray-600 dark:text-gray-500">
                  {{ humanFileSize(curFile.size) }}
                </p> -->
              </div>
              <p class="text-xs my-2"><span class="text-red-500">*</span>请选择要接收同步的目录</p>
              <Button
                outlined
                rounded
                severity="contrast"
                class="w-full tracking-wider"
                @click="selectSyncDir"
                ><Icon name="solar:folder-with-files-line-duotone" class="mr-2" />{{
                  $t('btn.selectDir')
                }}</Button
              >
            </div>
            <!-- 对比目录结构 -->
            <div v-else-if="syncDirStatus.isDiffing" class="flex flex-col items-center mt-12">
              <!-- <Icon name="material-symbols-light:unknown-document-outline-rounded" size="64" /> -->
              <div class="loader2"></div>
              <p class="mt-8">对比结构中</p>
            </div>
            <!-- 选择要新增、更新、删除的文件列表 -->
            <div v-else>
              <p>请选择要新增的文件</p>
              <FilesTree
                :file-map="syncDirStatus.fileMapAdd"
                :disabled="status.isLock"
                v-model:selected-key="syncDirStatus.waitAddList"
              />
              <p class="mt-2">请选择要更新的文件</p>
              <FilesTree
                :file-map="syncDirStatus.fileMapUpdate"
                :disabled="status.isLock"
                v-model:selected-key="syncDirStatus.waitUpdateList"
              />
              <p class="mt-2">请选择要删除的文件</p>
              <FilesTree
                :file-map="syncDirStatus.fileMapDelete"
                :disabled="status.isLock"
                v-model:selected-key="syncDirStatus.waitDeleteList"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- 进度和操作按钮 -->
      <div class="mt-6 md:mt-0">

        <template v-if='peerFilesInfo.type !=="transText"'>
        <!-- 进度 -->
        <div>
            <!-- 当前文件进度 -->
            <p class="text-sm mt-2">{{ curFile.name }}</p>
            <ProgressBar
              :value="
                Math.round(curFile.size === 0 ? 0 : (curFile.transmittedBytes / curFile.size) * 100)
              "
            />
            <p class="text-right text-sm">
              <span>{{ humanFileSize(curFile.speed) }}/s</span
              ><span class="ml-4">{{ humanFileSize(curFile.transmittedBytes) }}</span
              ><span class="mx-1">/</span><span>{{ humanFileSize(curFile.size) }}</span>
            </p>

            <!-- 总进度 -->
            <p class="text-sm mt-4">{{ $t('label.totalProgress') }}</p>
            <ProgressBar
              :value="
                Math.round(totalFileSize === 0 ? 0 : (totalTransmittedBytes / totalFileSize) * 100)
              "
            />
            <div class="flex flex-row items-center text-sm">
              <span>{{ durationTimeStr }} / {{ remainingTimeStr }}</span>
              <div class="flex-1"></div>
              <span>{{ humanFileSize(totalSpeed) }}/s</span
              ><span class="ml-4">{{ humanFileSize(totalTransmittedBytes) }}</span
              ><span class="mx-1">/</span><span>{{ humanFileSize(totalFileSize) }}</span>
            </div>
          </div>
        </template>
          <!-- 操作按钮 -->
          <div v-if="status.warn.code === 0" class="my-16">
              <template v-if='peerFilesInfo.type !=="transText"'>
                <!-- 接收和终止 -->
                <Button
                  v-if="!status.isLock"
                  rounded
                  severity="contrast"
                  class="w-full tracking-wider"
                  :disabled="
                    !status.isConnectPeer ||
                    status.isReceiving ||
                    (peerFilesInfo.type === 'syncDir' && syncDirStatus.isDiffing)
                  "
                  @click="doReceive"
                  ><Icon name="solar:archive-down-minimlistic-line-duotone" class="mr-2" />{{
                    $t('btn.receive')
                  }}</Button
                >
                <!-- 终止传输 -->
                <NuxtLink :to="localePath('/')">
            <Button
              v-if="status.isReceiving"
              rounded
              outlined
              severity="danger"
              class="w-full tracking-wider"
              >{{ $t('btn.terminate') }}</Button
            >
          </NuxtLink>
              </template>

              <template v-if='peerFilesInfo.type ==="transText"' >
                  <div class="text_box">
                        <div style="width: 80%;align-items: center;">
                        <textarea v-model="peerFilesInfo.text" class="border border-neutral-300 dark:border-neutral-600 rounded w-full p-2 mb-4 h-32 resize-none bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100">

                        </textarea>
                        </div>
                  </div>

              </template>
              <!-- 传输完成 -->
              <div
                v-if="status.isDone"
                class="flex flex-col items-center justify-center py-4 gap-4 mb-4"
              >
                <Icon name="solar:confetti-line-duotone" size="100" class="text-amber-500" />
                <p class="text-xl tracking-wider">{{ $t('hint.transCompleted') }}</p>
              </div>
              <template v-if='peerFilesInfo.type !=="transText"'>
                <!-- 如果不支持现代文件访问，则显示手动下载按钮 -->
                <Button
                  v-if="status.isDone && !isModernFileAPISupport"
                  rounded
                  outlined
                  severity="contrast"
                  class="w-full tracking-wider"
                  @click="downloadFile"
                  ><Icon name="solar:download-minimalistic-linear" class="mr-2" />{{
                    $t('btn.download')
                  }}</Button
                >
              </template>

          <div v-if="status.isDone" class="py-6">
            <!-- buy me coffee -->
            <NuxtLink to="https://www.buymeacoffee.com/shouchen" target="_blank">
              <Button rounded outlined severity="contrast" class="w-full tracking-wider"
                ><IconCoffee class="size-[1.125rem] mr-2" />{{ $t('btn.buyMeCoffee') }}</Button
              >
            </NuxtLink>

            <!-- 回主页 -->
            <NuxtLink :to="localePath('/')">
              <Button rounded severity="contrast" class="w-full tracking-wider block mt-6"
                ><Icon name="solar:home-2-linear" class="mr-2" />{{ $t('btn.toHome') }}</Button
              ></NuxtLink
            >
          </div>
        </div>
        <!-- 业务异常 -->
        <div v-if="!status.isDone" class="mb-16 flex flex-col items-center justify-center py-10 gap-4">
          <Icon
            name="material-symbols-light:warning-outline-rounded"
            size="96"
            class="text-amber-500 dark:text-amber-600"
          />
          <!-- 当前浏览器不支持目录传输 -->
          <div v-if="status.warn.code === -1">
            <p class="text-xl tracking-wider">{{ $t('hint.noSupportDirTrans') }}</p>
          </div>
          <!-- 连接异常中断 -->
          <div v-else-if="status.warn.code === -2">
            <p class="text-xl tracking-wider">{{ $t('hint.connectInterrupted') }}</p>
          </div>
          <!-- 文件哈希校验失败 -->
          <div v-else-if="status.warn.code === -3">
            <p class="text-xl tracking-wider">{{ $t('hint.hashCheckFail') }}</p>
          </div>

          <div class="text-center py-4">
            <NuxtLink :to="localePath('/')">
              <Button severity="contrast" class="tracking-wider"
                ><Icon name="solar:home-2-linear" class="mr-2" />{{ $t('btn.toHome') }}</Button
              ></NuxtLink
            >
          </div>
        </div>

        <!-- <p>{{ totalFileSize }}</p>
          <p>{{ totalTransmittedBytes }}</p>
          <p>{{ waitReceiveFileList }}</p> -->
      </div>
    </div>
  </div>
</template>

<style scoped>
.text_box{
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
}
.loader {
  width: 100px;
  height: 40px;
  --g: radial-gradient(
      farthest-side,
      transparent calc(95% - 3px),
      currentColor calc(100% - 3px) 98%,
      transparent 101%
    )
    no-repeat;
  background: var(--g), var(--g), var(--g);
  background-size: 30px 30px;
  animation: l9 1s infinite alternate;
}
@keyframes l9 {
  0% {
    background-position:
      0 50%,
      50% 50%,
      100% 50%;
  }
  20% {
    background-position:
      0 0,
      50% 50%,
      100% 50%;
  }
  40% {
    background-position:
      0 100%,
      50% 0,
      100% 50%;
  }
  60% {
    background-position:
      0 50%,
      50% 100%,
      100% 0;
  }
  80% {
    background-position:
      0 50%,
      50% 50%,
      100% 100%;
  }
  100% {
    background-position:
      0 50%,
      50% 50%,
      100% 50%;
  }
}

.loader2 {
  width: 64px;
  aspect-ratio: 1;
  display: grid;
  border: 4px solid #0000;
  border-radius: 50%;
  /* border-right-color: #25b09b; */
  border-right-color: currentColor;
  animation: l15 1s infinite linear;
}
.loader2::before,
.loader2::after {
  content: '';
  grid-area: 1/1;
  margin: 2px;
  border: inherit;
  border-radius: 50%;
  animation: l15 2s infinite;
}
.loader2::after {
  margin: 8px;
  animation-duration: 3s;
}
@keyframes l15 {
  100% {
    transform: rotate(1turn);
  }
}
</style>
