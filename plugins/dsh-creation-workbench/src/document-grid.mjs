// Spreadsheet clipboard uses quoted TSV for tabs, quotes and multiline cells.
export function parseGridClipboard(text) {
  const rows=[[]];let value='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++}else if(c==='"'){quoted=false;closed=true}else value+=c;continue}
    if(c==='"'&&!value&&!closed){quoted=true;continue}
    if(c==='\t'||c==='\n'||c==='\r'){
      rows.at(-1).push(value);value='';closed=false;
      if(c!=='\t'){if(c==='\r'&&text[i+1]==='\n')i++;if(i<text.length-1)rows.push([])}
    }else{if(closed)throw new Error('粘贴内容的引号格式无效');value+=c}
  }
  if(quoted)throw new Error('粘贴内容有未闭合引号');
  if(!/[\r\n]$/.test(text))rows.at(-1).push(value);
  return rows;
}
export function gridClipboard(rows){return rows.map(row=>row.map(cell=>/[\t\r\n"]/.test(cell)?'"'+cell.replaceAll('"','""')+'"':cell).join('\t')).join('\n')}
