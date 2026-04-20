import { getDbClient } from '../client.js'

export type Team = {
  id: string
  tenant_id: string
  name: string
  description: string | null
  lead_agent_id: string | null
  lead_session_id: string | null
  created_at: Date
}

export type TeamMember = {
  id: string
  team_id: string
  agent_id: string
  name: string
  agent_type: string | null
  model: string | null
  color: string | null
  status: string
  session_id: string | null
  joined_at: Date
}

export type CreateTeamInput = {
  tenantId: string
  name: string
  description?: string
  leadAgentId?: string
}

export type AddTeamMemberInput = {
  teamId: string
  agentId: string
  name: string
  agentType?: string
  model?: string
  color?: string
}

export async function createTeam(input: CreateTeamInput): Promise<Team> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO teams (tenant_id, name, description, lead_agent_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.tenantId, input.name, input.description || null, input.leadAgentId || null]
  )
  return rows[0]
}

export async function getTeam(teamId: string, tenantId: string): Promise<Team | null> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM teams WHERE id = $1 AND tenant_id = $2',
    [teamId, tenantId]
  )
  return rows[0] || null
}

export async function listTeams(tenantId: string): Promise<Team[]> {
  const db = getDbClient()
  const { rows } = await db.query(
    'SELECT * FROM teams WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId]
  )
  return rows
}

export async function addTeamMember(input: AddTeamMemberInput): Promise<TeamMember> {
  const db = getDbClient()
  const { rows } = await db.query(
    `INSERT INTO team_members (team_id, agent_id, name, agent_type, model, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.teamId, input.agentId, input.name, input.agentType || null, input.model || null, input.color || null]
  )
  return rows[0]
}

export async function removeTeamMember(memberId: string): Promise<boolean> {
  const db = getDbClient()
  const { rowCount } = await db.query(
    'DELETE FROM team_members WHERE id = $1',
    [memberId]
  )
  return (rowCount ?? 0) > 0
}
