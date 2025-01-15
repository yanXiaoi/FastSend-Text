<script setup lang="ts">
const { t } = useI18n()
const localePath = useLocalePath()
const router = useRouter()
const toast = useToast()
const isModernFileAPISupport = ref(true)
const isDirSupport = ref(true)
const receiveCode = ref('')
const isFileDraging = ref(false)
const fileDragArea = ref()
const textModal = ref({
    isShow:false,
    text:'',
})

const { data: transCount } = useFetch('/api/transCount', {
  method: 'post',
  onResponseError() {
    toast.add({
      severity: 'error',
      summary: 'Error',
      detail: t('hint.serviceUnavailable')
    })
  }
})

useSeoMeta({
  title: t('home')
})

// 发起目录同步
function syncDir() {
  // if (isModernFileAPISupport.value) {
  // showDirectoryPicker()
  //   .then((fh) => {
  //     useFullScreenLoader(true)
  //     return dealFilesFromHandler(fh)
  //   })
  //   .then((fileMap) => {
  //     if (Object.keys(fileMap).length === 0) {
  //       throw '目录为空'
  //     }
  //     useFilesInfo('syncDir', fileMap)
  //     router.push(localePath('/sender'))
  //     useFullScreenLoader(false)
  //   })
  //   .catch((e) => {
  //     console.warn(e)
  //     toast.add({ severity: 'error', summary: 'Error', detail: e, life: 3000 })
  //     useFullScreenLoader(false)
  //   })
  // } else {
  // 注意：移动端不支持选择目录
  selectDir()
    .then((files) => {
      useFullScreenLoader(true)
      return dealFilesFormList(files)
    })
    .then((fileMap) => {
      if (Object.keys(fileMap).length === 0) {
        throw 'The directory is empty'
      }
      // console.log(fileMap)
      useFilesInfo('syncDir', fileMap)
      router.push(localePath('/sender'))
    })
    .catch((e) => {
      console.warn(e)
      toast.add({ severity: 'error', summary: 'Error', detail: e, life: 5e3 })
      useFullScreenLoader(false)
    })
  // }
}

// 发送目录
function sendDir() {
  // 注意：移动端不支持选择目录
  selectDir()
    .then((files) => {
      useFullScreenLoader(true)
      return dealFilesFormList(files)
    })
    .then((fileMap) => {
      if (Object.keys(fileMap).length === 0) {
        throw '目录为空'
      }
      useFilesInfo('transDir', fileMap)
      router.push(localePath('/sender'))
    })
    .catch((e) => {
      console.warn(e)
      toast.add({ severity: 'error', summary: 'Error', detail: e, life: 5e3 })
      useFullScreenLoader(false)
    })
}

// 发送文件
function sendFile() {
  selectFile()
    .then((file) => {
      useFullScreenLoader(true)
      useFilesInfo('transFile', dealFilesFormFile(file))
      router.push(localePath('/sender'))
    })
    .catch((e) => {
      console.warn(e)
      toast.add({ severity: 'error', summary: 'Error', detail: e, life: 5e3 })
      useFullScreenLoader(false)
    })
}

//发送（共享）文本
function sendText() {
    // 弹出输入框
    const text = textModal.value.text;
    if (text) {
        useFilesInfo('transText', { 'text':text })
        router.push(localePath('/sender'))
    }else {
        toast.add({ severity: 'error', summary: 'Error', detail: '文本不能为空', life: 5e3 })
    }
}

watch(isFileDraging, (val) => {
  if (val) {
    fileDragArea.value.style.display = 'flex'
    fileDragArea.value.style.opacity = '1'
  } else {
    fileDragArea.value.style.opacity = '0'
    setTimeout(() => {
      if (fileDragArea.value) {
        fileDragArea.value.style.display = 'none'
      }
    }, 300)
  }
})

function fileDragOver(e: Event) {
  e.preventDefault()
  isFileDraging.value = true
}

function fileDrop(e: DragEvent) {
  e.preventDefault()
  isFileDraging.value = false
  // console.log('fileDrop', e)

  if (e.dataTransfer && e.dataTransfer.items.length > 0) {
    const item = e.dataTransfer.items[0].webkitGetAsEntry()
    const files = e.dataTransfer.files
    if (item) {
      if (item.isFile) {
        const file = files[0]
        useFullScreenLoader(true)
        useFilesInfo('transFile', dealFilesFormFile(file))
        router.push(localePath('/sender'))
      } else if (item.isDirectory) {
        toast.add({
          severity: 'warn',
          summary: 'Warn',
          detail: t('hint.noSupportFolderDrag'),
          life: 3e3
        })
      }
    }
  }
}

watch(
  receiveCode,
  () => {
    if (receiveCode.value.length === 4) {
      if (/^\d{4}$/.test(receiveCode.value)) {
        useFullScreenLoader(true)
        router.push({ path: localePath('recipient'), query: { code: receiveCode.value } })
      } else {
        receiveCode.value = receiveCode.value.replaceAll(' ', '')
      }
    }
    // console.log(inputCode.value)
  },
  { flush: 'sync' }
)

onMounted(() => {
  isModernFileAPISupport.value = isModernFileAPIAvailable()
  isDirSupport.value = supportsDirectorySelection()
  useFilesInfo('', {})

  window.ondragenter = (e) => {
    e.preventDefault()
    isFileDraging.value = true
  }
  window.ondragleave = (e: DragEvent) => {
    e.preventDefault()
    if (!e.relatedTarget) {
      isFileDraging.value = false
    }
  }
  window.ondragover = (e) => {
    e.preventDefault()
  }
  window.ondrop = (e) => {
    e.preventDefault()
    isFileDraging.value = false
  }
})
</script>

<template>
  <div class="md:px-[10vw] pb-4">
    <div
      class="fixed top-0 left-0 right-0 bottom-0 inset-0 -z-50 h-full w-full bg-white dark:bg-zinc-950 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#25272b_1px,transparent_1px)] [background-size:16px_16px]"
    ></div>
    <div class="py-6 px-8 text-center">
      <h1 class="md:text-6xl text-5xl tracking-wider font-serif">Fast Send</h1>
      <p
        class="mt-4 leading-6 tracking-widest text-sm md:text-base text-gray-600 dark:text-gray-200"
      >
        {{ $t('description') }}
      </p>
    </div>

    <p
      class="text-xs md:text-sm text-neutral-600 dark:text-neutral-400 p-4"
      v-show="!isModernFileAPISupport"
    >
      <span class="text-red-500">*</span>{{ $t('hint.noModernFileAPIWarn') }}
    </p>

    <div class="md:grid md:grid-cols-2 gap-4 my-6 px-4">
      <div class="flex flex-col items-center relative px-4 py-8">
        <!-- 拖放指示 -->
        <div
          ref="fileDragArea"
          @dragover="fileDragOver"
          @drop="fileDrop"
          class="file-drag-area absolute left-0 top-0 right-0 bottom-0 flex-col items-center justify-center rounded-lg bg-white/60 dark:bg-black/60 backdrop-blur-sm border border-dashed border-neutral-500 z-40"
        >
          <Icon name="solar:file-send-linear" size="48" />
          <p class="mt-4">{{ $t('label.dragHereToSendFile') }}</p>
        </div>

        <h2 class="text-2xl tracking-wider flex flex-row items-center gap-2">
          <Icon name="solar:card-send-linear" />{{ $t('label.quickStart') }}
        </h2>

        <Button
          outlined
          rounded
          class="block w-full tracking-wider mt-6"
          severity="contrast"
          @click="sendFile"
          ><Icon name="solar:file-line-duotone" class="mr-2" />{{ $t('btn.sendFile') }}</Button
        >
        <Button
          outlined
          rounded
          class="block w-full tracking-wider mt-6"
          severity="contrast"
          :disabled="!isDirSupport"
          @click="sendDir"
          ><Icon name="solar:folder-with-files-line-duotone" class="mr-2" />{{
            $t('btn.sendDir')
          }}</Button
        >
        <Button
          outlined
          rounded
          class="block w-full tracking-wider mt-6"
          severity="contrast"
          :disabled="!isDirSupport"
          @click="textModal.isShow = true"
          ><Icon name="solar:text-field-outline" class="mr-2" />{{
            $t('btn.sendText')
          }}</Button
        >
        <!-- <Button
          rounded
          class="block w-full tracking-wider mt-6"
          severity="contrast"
          :disabled="!isModernFileAPISupport"
          @click="syncDir"
          ><Icon name="solar:refresh-square-broken" class="mr-2" />{{ $t('btn.syncDir') }}</Button
        > -->
      </div>

      <div
        class="flex flex-col items-center space-y-6 md:space-y-12 mt-8 md:mt-0 px-4 md:py-8 py-0"
      >
        <h2 class="text-2xl tracking-wider flex flex-row items-center gap-2">
          <Icon name="solar:card-recive-linear" />{{ $t('label.receiveCode') }}
        </h2>

        <InputOtp integerOnly v-model:model-value="receiveCode" class="gap-4">
          <template #default="{ attrs, events, index }">
            <input
              :autofocus="index === 1"
              type="number"
              v-bind="attrs"
              v-on="events"
              class="border border-neutral-500/70 rounded bg-neutral-50 dark:bg-zinc-900 focus:outline-none size-14 text-2xl text-center no-arrows"
            />
          </template>
        </InputOtp>
      </div>
    </div>

    <div class="flex flex-row items-baseline justify-center pt-8 text-sm">
      <span>{{ $t('label.transmitted') }}</span>
      <span class="text-2xl m-2 tracking-wider">{{ transCount }}</span>
      <span>{{ $t('label.times') }}</span>
    </div>
  </div>
  <!--用户发送文本模态框-->
    <div v-if="textModal.isShow" class="fixed inset-0 flex items-center justify-center z-50 bg-black bg-opacity-50">
        <div class="bg-white dark:bg-zinc-800 rounded-lg shadow-lg p-6 w-11/12 md:w-1/3">
            <h2 class="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">发送文本</h2>
            <textarea v-model="textModal.text" placeholder="请输入待发送的文本" class="border border-neutral-300 dark:border-neutral-600 rounded w-full p-2 mb-4 h-32 resize-none bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100"></textarea>
            <div class="flex justify-end">
                <button @click="sendText" class="bg-blue-500 text-white rounded px-4 py-2 mr-2">发送</button>
                <button @click="textModal.isShow = false" class="bg-gray-300 dark:bg-gray-700 rounded px-4 py-2">取消</button>
            </div>
        </div>
    </div>
</template>

<style>
.file-drag-area {
  display: none;
  opacity: 0;
  transition-property: opacity;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 300ms;
}
</style>
