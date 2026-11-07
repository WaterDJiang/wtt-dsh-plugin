import React from 'react'

export function UiIcon({name,size=16,...props}) {
 const paths={file:<><path d="M13 3H5v18h14V9l-6-6Z"/><path d="M13 3v6h6M8 15h8M12 11v8"/></>,folder:<><path d="M3 7V4h6l2 3h10v13H3V7Z"/><path d="M8 13h8M12 9v8"/></>,check:<path d="m4 12 5 5L20 6"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,expand:<><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></>,restore:<><path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6"/></>,back:<path d="m14 5-7 7 7 7"/>,refresh:<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>,more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>}
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}

export function UiButton({variant='quiet',size='normal',iconOnly=false,className='',type='button',children,ref,...props}) {
 return <button ref={ref} type={type} data-ui-variant={variant} data-ui-size={size} className={`wtt-ui-button${iconOnly?' is-icon-only':''}${className?' '+className:''}`} {...props}>{children}</button>
}
export function UiLink({variant='ghost',size='normal',iconOnly=false,className='',children,...props}) {
 return <a data-ui-variant={variant} data-ui-size={size} className={`wtt-ui-button${iconOnly?' is-icon-only':''}${className?' '+className:''}`} {...props}>{children}</a>
}

export function PanelHeader({title,titleId,subtitle,subtitleId,format,downloadHref,downloadLabel='下载当前文件',expanded=false,onToggleWidth,expandLabel='展开侧栏',restoreLabel='还原侧栏宽度',onClose,closeLabel='关闭预览',closeDisabled=false,className=''}) {
 return <header className={`wtt-ui-panel-header${className?' '+className:''}`}>
  <div className="wtt-ui-panel-heading"><div><h2 id={titleId} title={title}>{title}</h2>{format&&<span className="wtt-ui-format">{format}</span>}</div>{subtitle&&<p id={subtitleId} title={typeof subtitle==='string'?subtitle:undefined}>{subtitle}</p>}</div>
  <div className="wtt-ui-panel-actions" role="toolbar" aria-label="窗口操作">
   {downloadHref&&<UiLink iconOnly href={downloadHref} download aria-label={downloadLabel} title={downloadLabel} data-panel-action="download"><UiIcon name="download"/></UiLink>}
   {onToggleWidth&&<UiButton variant="ghost" iconOnly aria-label={expanded?restoreLabel:expandLabel} title={expanded?restoreLabel:expandLabel} aria-pressed={expanded} onClick={onToggleWidth} data-panel-action="expand"><UiIcon name={expanded?'restore':'expand'}/></UiButton>}
   {onClose&&<UiButton variant="ghost" iconOnly disabled={closeDisabled} aria-label={closeLabel} title={closeLabel} onClick={onClose} data-panel-action="close"><UiIcon name="close"/></UiButton>}
  </div>
 </header>
}
export function PanelToolbar({children,className='',...props}) {
 return <div className={`wtt-ui-panel-toolbar${className?' '+className:''}`} {...props}>{children}</div>
}
export function DialogHeader({title,titleId,description,descriptionId,onClose,closeLabel='关闭窗口',busy=false}) {
 return <PanelHeader title={title} titleId={titleId} subtitle={description} subtitleId={descriptionId} onClose={onClose} closeLabel={closeLabel} closeDisabled={busy}/>
}
export function DialogFooter({children,className='',...props}) {
 return <footer className={`wtt-ui-dialog-footer${className?' '+className:''}`} {...props}>{children}</footer>
}

export function DialogBody({children,className='',...props}) { return <div className={`wtt-ui-dialog-body${className?' '+className:''}`} {...props}>{children}</div> }
