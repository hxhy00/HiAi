export const LocalWebServicesIpc = {
  List: 'localWebServices:list',
} as const;
export type LocalWebServicesIpc = typeof LocalWebServicesIpc[keyof typeof LocalWebServicesIpc];

/**
 * How a local service's project directory was discovered. These sources are
 * produced by local detection (process inspection, artifact metadata, tool
 * output, workspace scanning) and are unrelated to remote deployment.
 */
export const LocalWebServiceCandidateSource = {
  Process: 'process',
  ProcessCwd: 'process_cwd',
  ArtifactMetadata: 'artifact_metadata',
  TextLabeledPath: 'text_labeled_path',
  TextFileLink: 'text_file_link',
  TextCdCommand: 'text_cd_command',
  TextCommonParent: 'text_common_parent',
  ToolWorkingDirectory: 'tool_working_directory',
  ToolCdCommand: 'tool_cd_command',
  ToolPwdResult: 'tool_pwd_result',
  Workspace: 'workspace',
  WorkspaceChild: 'workspace_child',
  Cache: 'cache',
  Manual: 'manual',
} as const;

export type LocalWebServiceCandidateSource =
  (typeof LocalWebServiceCandidateSource)[keyof typeof LocalWebServiceCandidateSource];

export interface LocalWebServiceProjectCandidate {
  directory: string;
  source: LocalWebServiceCandidateSource;
  confidence: number;
  reason?: string;
  evidence?: string;
  messageId?: string;
  artifactId?: string;
  pid?: number;
  detectedAt?: number;
}

export interface LocalWebService {
  id: string;
  title: string;
  url: string;
  host: string;
  port: number;
  online: boolean;
  projectDirectory?: string;
  projectCandidates?: LocalWebServiceProjectCandidate[];
}

export interface ListLocalWebServicesOptions {
  preferredPorts?: number[];
}
