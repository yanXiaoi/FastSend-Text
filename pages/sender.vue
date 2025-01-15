<script setup lang="ts">
import CryptoJS from 'crypto-js'
import { toCanvas } from 'qrcode'
import { PeerDataChannel } from '~/utils/PeerDataChannel'

const { t } = useI18n()
const localePath = useLocalePath()
const router = useRouter()
const toast = useToast()
const userInfo = useUserInfo()
const peerUserInfo = ref({ nickname: 'unknown', avatarURL: '' })
const filesInfo = useFilesInfo()
const isConfirmDefault = useConfirmDefault()
const code = ref('')
const qrcodeElm = ref()
const hasher = CryptoJS.algo.MD5.create()
const totalTransmittedBytes = ref(0)
const startTime = ref(0)
const totalSpeed = ref(0)
const durationTimeStr = ref('0:00:00')
const curFile = ref<any>({
  name: '',
  size: 0,
  transmittedBytes: 0,
  lastBytes: 0,
  speed: 0,
  startTime: 0
})
const status = ref({
  isIniting: true,
  isConnectServer: false,
  isConnectPeer: false,
  isWaitingConnect: true,
  isWaitingConfirm: true,
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

let calcSpeedJobId: any
let ws: WebSocket | null
let pdc: PeerDataChannel | null

useSeoMeta({
  title: t('sender')
})

function dispose() {
  clearInterval(calcSpeedJobId)
  ws?.close()
  pdc?.dispose()
}

// 计算传输速度和用时
function calcSpeedFn() {
  totalSpeed.value = totalTransmittedBytes.value / ((new Date().getTime() - startTime.value) / 1e3)
  durationTimeStr.value = formatTime(new Date().getTime() - startTime.value)
}

async function confirmUser(isTrust: boolean) {
  if (!isTrust) {
    // 用户拒绝传输
    await pdc?.sendData(JSON.stringify({ type: 'err', data: 403 }))
    router.replace(localePath('/'))
    return
  }
  status.value.isWaitingConfirm = false
  await pdc?.sendData(JSON.stringify({ type: 'user', data: userInfo.value }))
  if (filesInfo.value.type === 'syncDir') {
    const keys = Object.keys(filesInfo.value.fileMap)
    if (keys.length > 0) {
      filesInfo.value.root = filesInfo.value.fileMap[keys[0]].paths[0]
    } else {
      filesInfo.value.root = 'Unknown'
    }
    filesInfo.value.fileMap = fileMapRemoveRoot(filesInfo.value.fileMap)
  }
  await pdc?.sendData(JSON.stringify({ type: 'files', data: filesInfo.value }))
}

// 处理JSON对象
async function handleObjData(obj: any) {
  // console.log(obj)
  if (obj.type === 'user') {
    // 用户信息
    peerUserInfo.value = obj.data
    status.value.isWaitingConnect = false
    if (isConfirmDefault.value) {
      // 如果开启自动确认，则直接确认
      confirmUser(true)
    }
  } else if (obj.type === 'reqFile') {
    // console.log('reqFile', obj)

    // 请求文件
    hasher.reset()
    const fileDetail = filesInfo.value.fileMap[obj.data]
    const file = fileDetail?.file
    const name = fileDetail?.paths[fileDetail?.paths?.length - 1] + ''
    // console.log(fileDetail)

    if (!file) {
      // 找不到对应的文件
      await pdc?.sendData(JSON.stringify({ type: 'err', data: 404 }))
      return
    }
    curFile.value.name = name
    curFile.value.size = file.size
    curFile.value.transmittedBytes = 0
    curFile.value.lastBytes = 0
    curFile.value.speed = 0
    curFile.value.startTime = new Date().getTime()

    // 计算分片数量
    const sliceSize = 1024 * 1024
    const count = Math.ceil(file.size / sliceSize)
    // console.log('count', count)

    for (let i = 0; i < count; i++) {
      // console.log('i', i)
      const ab = await file.slice(i * sliceSize, (i + 1) * sliceSize).arrayBuffer()

      // console.log('ab', ab.byteLength)

      if (ab.byteLength > 0) {
        // 计算哈希
        hasher.update(CryptoJS.lib.WordArray.create(ab))
        // 发送数据
        await pdc?.sendData(ab)
        // 更新状态
        curFile.value.lastBytes = curFile.value.transmittedBytes
        curFile.value.transmittedBytes += ab.byteLength
        const nowTime = new Date().getTime()
        curFile.value.speed =
          (curFile.value.speed + ab.byteLength / ((nowTime - curFile.value.startTime) / 1e3)) / 2
        curFile.value.startTime = nowTime
      }
    }
    // 发送Hash值
    const hash = hasher.finalize().toString(CryptoJS.enc.Base64)
    await pdc?.sendData(JSON.stringify({ type: 'fileDone', data: hash }))

    // console.log('req file done', obj.data)
  } else if (obj.type === 'calcFileHash') {
    // 计算指定文件哈希
    hasher.reset()
    const fileDetail = filesInfo.value.fileMap[obj.data]
    const file = fileDetail?.file
    if (!file) {
      // 找不到对应的文件
      await pdc?.sendData(JSON.stringify({ type: 'err', data: 404 }))
      return
    }
    // 计算并发送哈希
    const hash = await calcMD5(file)
    await pdc?.sendData(JSON.stringify({ type: 'fileHash', data: hash }))
  } else if (obj.type === 'done') {
    // 传输完成
    status.value.isDone = true
    dispose()
    toast.add({
      severity: 'success',
      summary: 'Success',
      detail: t('hint.transCompleted'),
      life: 5e3
    })
  } else if (obj.type === 'err') {
    // 错误
    if (obj.data) {
      // -1，不支持现代文件访问API，不能传输目录
      status.value.warn.code = obj.data
    }
  } else if (obj.type === 'transText') {
    // 处理传输文本
    const text = obj.data.text
    await pdc?.sendData(JSON.stringify({ type: 'transText', data: text }))
    status.value.isWaitingConfirm = false
    toast.add({
      severity: 'success',
      summary: 'Success',
      detail: t('hint.textSent'),
      life: 5e3
    })
  }
}

function initPDC() {
  pdc = new PeerDataChannel({ iceServers: pubIceServers })
  pdc.onSDP = (sdp) => ws?.send(JSON.stringify({ type: 'sdp', data: sdp }))
  pdc.onICECandidate = (candidate) =>
    ws?.send(JSON.stringify({ type: 'candidate', data: candidate }))
  pdc.onDispose = () => {
    status.value.isConnectPeer = false
    dispose()
    toast.add({ severity: 'warn', summary: 'Warn', detail: 'Disconnected', life: 5000 })
    if (!status.value.isDone && status.value.warn.code === 0) {
      // 传输未完成，连接断开
      status.value.warn.code = -10
    }
  }
  pdc.onError = (err) => {
    console.error(err)
    status.value.isConnectPeer = false
    dispose()
  }
  pdc.onConnected = () => {
    // console.log('onConnected')
    status.value.isConnectPeer = true
    status.value.isWaitingConfirm = true
  }
  pdc.onReceive = async (data, info) => {
    // console.log('data', data)
    // console.log(info.size, info.duration, info.size / (info.duration / 1e3))

    if (typeof data === 'string') {
      await handleObjData(JSON.parse(data))
    }
  }
}

async function copyLink() {
  await copyToClipboard(location.origin + localePath('/recipient') + '?code=' + code.value)
  toast.add({
    severity: 'success',
    summary: 'Success',
    detail: 'Code copied successfully',
    life: 2e3
  })
}

onMounted(() => {
  useFullScreenLoader(false)
  if (!filesInfo.value.type) {
    router.replace(localePath('/'))
    return
  }

  if (filesInfo.value.type === 'transText' && !filesInfo.value.text) {
    toast.add({ severity: 'warn', summary: 'Warn', detail: '文本为空', life: 5e3 })
    router.replace(localePath('/'))
    return
  }

  if (Object.keys(filesInfo.value.fileMap).length === 0 && filesInfo.value.type !== 'transText') {
      toast.add({ severity: 'warn', summary: 'Warn', detail: '目录为空', life: 5e3 })
      router.replace(localePath('/'))
      return
  }

  try {
    ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/connect')
  } catch (e) {
    // 连接信令服务器失败
    console.error(e)
    status.value.error.code = -5
    status.value.error.msg = e + ''
    return
  }
  ws.onopen = () => {
    status.value.isConnectServer = true
    ws?.send(JSON.stringify({ type: 'send' }))
  }
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data)
    if (data.type === 'code') {
      code.value = data.code
      setTimeout(() => {
        toCanvas(
          qrcodeElm.value,
          location.origin + localePath('/recipient') + '?code=' + code.value,
          { scale: 5 }
        )
      }, 1)
      initPDC()
      status.value.isIniting = false
    } else if (data.type === 'sdp') {
      pdc?.setRemoteSDP(data.data)
    } else if (data.type === 'candidate') {
      pdc?.addICECandidate(data.data)
    } else if (data.type === 'err') {
      // -1 初始化连接码失败，稍后再试
      status.value.error.code = data.data
      status.value.isWaitingConnect = false
      toast.add({ severity: 'error', summary: 'Error', detail: data.msg })
      console.warn(data.msg)
    }
  }
  ws.onclose = () => {
    status.value.isConnectServer = false
    if (status.value.isIniting) {
      // 连接信令服务器失败
      status.value.error.code = -5
      status.value.error.msg = 'Connect sign server error'
      toast.add({ severity: 'error', summary: 'Error', detail: 'Connect sign server error' })
    } else if (status.value.isWaitingConnect) {
      // 等待接收端连接超时
      status.value.error.code = -10
      status.value.error.msg = 'Timeout'
      // toast.add({ severity: 'error', summary: 'Error', detail: 'Waiting for timeout' })
    }
  }
  ws.onerror = (err) => {
    console.error(err)
    status.value.isConnectServer = false
  }
})

onUnmounted(() => {
  dispose()
})
</script>

<template>
  <div>
    <!-- 错误页面 -->
    <div v-if="status.error.code !== 0">
      <!-- 当前连接用户太多 -->
      <div v-if="status.error.code === -1" class="text-center">
        <Icon name="material-symbols-light:account-circle-off-outline-rounded" size="100" />
        <p class="text-xl tracking-wider py-8">{{ $t('hint.toManyPeople') }}</p>
      </div>

      <!-- 其他服务异常 -->
      <div v-else class="text-center">
        <Icon name="solar:sad-square-line-duotone" size="100" />
        <p class="text-xl tracking-wider pt-8">{{ $t('hint.serverError') }}</p>
        <p class="text-sm tracking-wider pb-8 mt-2">({{ $t('hint.closeTheProxy') }})</p>
      </div>

      <div class="text-center py-4">
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
      <p class="text-xs">{{ $t('hint.connecting') }}</p>
    </div>

    <!-- 等待链接 -->
    <div v-else-if="status.isWaitingConnect" class="mt-4 mb-16">
      <div class="md:mx-[10vw] p-4 text-center">
        <p class="text-xl tracking-wider">{{ $t('label.receiveCode') }}</p>
        <p
          class="mt-6 inline-block text-6xl md:text-7xl tracking-widest border py-4 px-8 border-dashed border-neutral-400 dark:border-neutral-500"
        >
          {{ code }}
        </p>
      </div>

      <!-- 二维码和复制链接按钮 -->
      <div class="flex flex-col items-center justify-center gap-4">
        <canvas ref="qrcodeElm" class="size-52"></canvas>
        <Button size="small" severity="contrast" @click="copyLink" class="tracking-wider"
          ><Icon name="solar:link-minimalistic-2-linear" class="mr-2" />{{
            $t('btn.copyLink')
          }}</Button
        >
      </div>
    </div>

    <!-- 连接成功 -->
    <div v-else>
      <!-- 接入的用户 -->
      <div class="flex flex-col items-center mt-4">
        <div class="flex-col items-center py-4 px-8 rounded-lg shadow flex">
          <Avatar shape="circle" size="xlarge" :image="peerUserInfo.avatarURL" class="shadow" />
          <p class="text-center mt-2">{{ peerUserInfo.nickname }}</p>
        </div>
      </div>

      <!-- 业务异常 -->
      <div
        v-if="status.warn.code !== 0"
        class="flex flex-col items-center justify-center py-10 gap-4"
      >
        <Icon
          name="material-symbols-light:warning-outline-rounded"
          size="96"
          class="text-amber-500 dark:text-amber-600"
        />
        <p v-if="status.warn.code === -1" class="text-xl tracking-wider">
          {{ $t('hint.noSupportDirTrans2') }}
        </p>
        <p v-else-if="status.warn.code === -10" class="text-xl tracking-wider">
          {{ $t('hint.connectInterrupted') }}
        </p>

        <div class="text-center py-4">
          <NuxtLink :to="localePath('/')">
            <Button severity="contrast" class="tracking-wider"
              ><Icon name="solar:home-2-linear" class="mr-2" />{{ $t('btn.toHome') }}</Button
            ></NuxtLink
          >
        </div>
      </div>

      <!-- 传输确认 -->
      <div v-else-if="status.isWaitingConfirm" class="p-4 mt-6">
        <p class="text-center text-2xl tracking-wider">{{ $t('hint.areYouSureContinue') }}</p>
        <div class="flex flex-row items-center justify-center gap-6 mt-8">
          <Button outlined severity="danger" @click="confirmUser(false)" class="tracking-wider"
            ><Icon name="solar:close-square-linear" class="mr-2" />{{ $t('btn.cancel') }}</Button
          >

          <Button severity="contrast" @click="confirmUser(true)" class="tracking-wider"
            ><Icon name="solar:check-square-linear" class="mr-2" />{{ $t('btn.ok') }}</Button
          >
        </div>
      </div>

      <!-- 发送端主界面 -->
      <div v-else-if="!status.isDone" class="p-4 mt-4 md:w-[50%] md:mx-auto">
        <p class="text-center text-xl tracking-wider my-4">{{ $t('hint.inTransit') }}</p>

        <div class="mt-8">
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
        </div>

        <div class="text-center mt-8">
          <NuxtLink :to="localePath('/')">
            <Button outlined severity="danger" class="tracking-wider"
              ><Icon name="solar:stop-linear" class="mr-2" />{{ $t('btn.terminate') }}</Button
            ></NuxtLink
          >
        </div>
      </div>
      <!-- 发送完毕 -->
      <div v-else class="flex flex-col items-center justify-center py-10 gap-4">
        <Icon name="solar:confetti-line-duotone" size="100" class="text-amber-500" />
        <p class="text-xl tracking-wider">{{ $t('hint.transCompleted') }}</p>
        <div class="py-4 flex flex-col md:flex-row items-center justify-center gap-6">
          <NuxtLink to="https://www.buymeacoffee.com/shouchen" target="_blank">
            <Button outlined severity="contrast" class="tracking-wider"
              ><IconCoffee class="size-[1.125rem] mr-2" />{{ $t('btn.buyMeCoffee') }}</Button
            >
          </NuxtLink>
          <NuxtLink :to="localePath('/')">
            <Button severity="contrast" class="tracking-wider"
              ><Icon name="solar:home-2-linear" class="mr-2" />{{ $t('btn.toHome') }}</Button
            ></NuxtLink
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
</style>
