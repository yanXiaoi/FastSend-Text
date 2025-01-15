export default function useFilesInfo(type?: string, fileMap?: any) {
  const filesInfo = useState<{ type: string; fileMap: any; root: string; text?: string }>('useFilesInfo', () => ({
    type: '',
    fileMap: {},
    root: '',
    text: ''
  }))
  if (type) {
    filesInfo.value.type = type
  }
  if (fileMap) {
    filesInfo.value.fileMap = fileMap
  }
  // 添加对文本信息的处理
  if (type === 'transText' && fileMap) {
    filesInfo.value.text = fileMap.text
  }
  return filesInfo
}