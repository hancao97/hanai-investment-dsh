import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { MasterPersona } from '../../contracts/src/index.ts'
import { installMasterSnapshot } from '../../masters/src/index.ts'
import type { HanaiPaths } from './paths.ts'

export interface PreparedExpertChatWorkspace {
  workspace: string
  skillPath: string
}

/** Owns only the expert snapshot/cwd. Conversation history remains in DSH. */
export class ExpertChatStore {
  constructor(
    private readonly paths: HanaiPaths,
    private readonly assetsRoot: string,
  ) {}

  prepareWorkspace(chatId: string, master: MasterPersona): PreparedExpertChatWorkspace {
    assertIdentifier(chatId)
    const workspace = join(this.paths.expertChatsDir, chatId, 'workspace')
    this.assertInDataRoot(workspace)
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    chmodSync(workspace, 0o700)
    const installed = installMasterSnapshot(this.assetsRoot, master, workspace, 'open-chat')
    return { workspace, skillPath: installed.skillPath }
  }

  remove(chatId: string): void {
    assertIdentifier(chatId)
    const directory = join(this.paths.expertChatsDir, chatId)
    this.assertInDataRoot(directory)
    rmSync(directory, { recursive: true, force: true })
  }

  private assertInDataRoot(path: string): void {
    const root = resolve(this.paths.root)
    const target = resolve(path)
    const rel = relative(root, target)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
      throw new Error('专家对谈路径越过 Hanai 数据根')
    }
  }
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('专家对谈标识格式无效')
}
