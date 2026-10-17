import type { InstalledKitRecord } from '../../shared/kit/constants';
import { SkinToolName, SkinWorkflowKind } from '../../shared/skin/constants';
import { SkinStore } from './skinStore';
import {
  createSkinToolHandler,
  type SkinToolRequest,
  type SkinToolResult,
} from './skinToolHandler';
import {
  type PreparedSkinWorkflowTurn,
  type PrepareSkinWorkflowTurnInput,
  SkinWorkflowRegistry,
} from './skinWorkflowRegistry';

export interface SkinRuntimeControllerOptions {
  rootDir: string;
  getInstalledKits: () => Record<string, InstalledKitRecord>;
  getParentSessionId: (sessionId: string) => string | null;
  resolveSessionId: (sessionKey: string) => string | null;
  onChanged?: () => void;
}

export class SkinRuntimeController {
  readonly store: SkinStore;
  private readonly workflowRegistry: SkinWorkflowRegistry;
  private readonly toolHandler: (request: SkinToolRequest) => Promise<SkinToolResult>;

  constructor(options: SkinRuntimeControllerOptions) {
    this.store = new SkinStore({ rootDir: options.rootDir });
    this.workflowRegistry = new SkinWorkflowRegistry({
      getInstalledKits: options.getInstalledKits,
      getParentSessionId: options.getParentSessionId,
    });
    // Skin authoring stays a desktop-only tool: it validates that the calling
    // session really is running the skin workflow, so the agent cannot create
    // or activate skins from an ordinary chat turn.
    this.toolHandler = createSkinToolHandler({
      store: this.store,
      isWorkflowAllowed: (sessionKey) => {
        const sessionId = options.resolveSessionId(sessionKey);
        if (!sessionId) return false;
        return this.workflowRegistry.resolve(sessionId)?.state.workflowKind
          === SkinWorkflowKind.SkinPack;
      },
      ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    });
  }

  prepareTurn(input: PrepareSkinWorkflowTurnInput): PreparedSkinWorkflowTurn {
    return this.workflowRegistry.prepareTurn(input);
  }

  handlesTool(tool: string): boolean {
    return tool === SkinToolName.Manage;
  }

  handleToolRequest(request: SkinToolRequest): Promise<SkinToolResult> {
    return this.toolHandler(request);
  }

  handleRuntimeComplete(sessionId: string): void {
    this.workflowRegistry.handleRuntimeComplete(sessionId);
  }

  handleRuntimeError(sessionId: string): void {
    this.workflowRegistry.handleRuntimeError(sessionId);
  }

  handleSessionDeleted(sessionId: string): void {
    this.workflowRegistry.handleSessionDeleted(sessionId);
  }
}
