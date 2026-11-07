export const skillLabel = skill => (skill.label || '').trim() || skill.name
export const skillSearchText = skill => `${skillLabel(skill)} ${skill.name} ${skill.description || ''}`.toLowerCase()
