import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const PE_SIGNATURE_OFFSET = 0x3c
const PE_SIGNATURE_SIZE = 6
const IMAGE_FILE_MACHINE_AMD64 = 0x8664

function readExactly(fd, buffer, position) {
  const count = readSync(fd, buffer, 0, buffer.length, position)
  if (count !== buffer.length) throw new Error('文件过短。')
}

export function assertWindowsX64Executable(path, label = '可执行文件') {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const dosHeader = Buffer.alloc(64)
    readExactly(fd, dosHeader, 0)
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw new Error(`${label} 不是 Windows PE 文件（缺少 MZ 文件头）：${path}`)
    }

    const peOffset = dosHeader.readUInt32LE(PE_SIGNATURE_OFFSET)
    if (peOffset < dosHeader.length || peOffset + PE_SIGNATURE_SIZE > size) {
      throw new Error(`${label} 的 Windows PE 文件头偏移无效：${path}`)
    }

    const peHeader = Buffer.alloc(PE_SIGNATURE_SIZE)
    readExactly(fd, peHeader, peOffset)
    if (peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`${label} 不是有效的 Windows PE 文件：${path}`)
    }
    const machine = peHeader.readUInt16LE(4)
    if (machine !== IMAGE_FILE_MACHINE_AMD64) {
      throw new Error(
        `${label} 不是 Windows x64 程序（machine=0x${machine.toString(16)}）：${path}`,
      )
    }
  } finally {
    closeSync(fd)
  }
}
