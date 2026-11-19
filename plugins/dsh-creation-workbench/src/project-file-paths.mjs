export const withinProjectPath=(entry,parent)=>entry===parent||entry.startsWith(parent+'/')
export const protectedProjectFilePath=path=>['courses','产物'].includes(path.split('/')[0])

export function remapProjectFilePath(path,changes){
  if(!path)return path
  const match=changes.find(item=>item.from&&['move','remove-copy'].includes(item.mode)&&withinProjectPath(path,item.from))
  return match?match.to?match.to+path.slice(match.from.length):null:path
}
