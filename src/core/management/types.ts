export interface ManagementRequest {
  requestId: string
  method: string
  params: Record<string, unknown>
}

export const managementMethods = {
  status: false,
  capabilities: false,
  'workspaces.list': false,
  'workspaces.add': true,
  'workspaces.hide': true,
  'workspaces.show': true,
  'sessions.list': false,
  'sessions.create': true,
  'sessions.select': true,
  'sessions.rename': true,
  'sessions.archive': true,
  'sessions.restore': true,
  'plugins.list': false,
  'plugins.create': true,
  'plugins.setEnabled': true,
  'plugins.configure': true,
  'plugins.delete': true,
  'skills.list': false,
  'skills.setEnabled': true,
  'mcp.list': false,
  'mcp.reload': true,
  'config.read': false,
  'config.set': true,
} as const
