type CloudMachineState = {
  id?: string
  last_seen_at?: string | null
  lastSeenAt?: string | null
  connected?: boolean
}

function machinesFrom(payload: unknown): CloudMachineState[] {
  if (!payload || typeof payload !== "object") return []
  const machines = (payload as { machines?: unknown }).machines
  return Array.isArray(machines) ? machines as CloudMachineState[] : []
}

function connected(machine: CloudMachineState): boolean {
  return !!(machine.connected || machine.last_seen_at || machine.lastSeenAt)
}

export function isCloudMachineConnected(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  return (payload as { connected?: boolean }).connected === true || machinesFrom(payload).some(connected)
}

export function isNewCloudMachineConnected(payload: unknown, existingMachineIds: ReadonlySet<string>): boolean {
  return machinesFrom(payload).some(machine =>
    !!machine.id && !existingMachineIds.has(machine.id) && connected(machine),
  )
}
