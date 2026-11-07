import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PptTextLayer } from './ppt-inline-editor.jsx'
import { pptObjectStyle } from './ppt-editor-state.mjs'
import { UiButton } from './ui/controls.jsx'

/** Only the strict server SVG adapter can supply this markup. No scripts/HTML/remote resources. */
export function SvgInlinePage({document,slide,renderedSlide,manifest,api,selectedId,marks,plus,onPlusToggle,onSelect,onEdit,onCommit,onEditingChange,disabled,readOnly,showBounds,onError,onObjectSelect}) {
  const host=useRef(null),[displayed,setDisplayed]=useState(null),[geometry,setGeometry]=useState(null)
  const href=slide&&manifest?.status==='ready'?api.getPageHref({draftId:manifest.draftId,revision:manifest.revision,page:slide.number}):null
  useEffect(()=>{
    if(!href)return
    const controller=new AbortController()
    fetch(href,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('SVG页面读取失败，请更新预览重试。')
      const markup=await response.text()
      if(!controller.signal.aborted)setDisplayed({href,slideId:slide.id,markup,renderedSlide:renderedSlide||slide})
    }).catch(error=>{if(!controller.signal.aborted)onError?.(error.message)})
    return ()=>controller.abort()
  },[href])
  const visible=displayed?.slideId===slide?.id?displayed:null
  useLayoutEffect(()=>{
    if(!visible||!host.current)return
    const measure=()=>{
      const svg=host.current?.querySelector('svg'),rect=svg?.getBoundingClientRect()
      if(!rect?.width||!rect.height)return
      const nodes=new Map([...svg.querySelectorAll('[data-wtt-svg-id]')].map(node=>[node.getAttribute('data-wtt-svg-id'),node]))
      const elements=visible.renderedSlide.elements.map(element=>{
        const node=nodes.get(element.id);if(!node)return element
        const box=node.getBoundingClientRect(),style=getComputedStyle(node),w=document.width/rect.width,h=document.height/rect.height
        const color=style.fill.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
        return {...element,bounds:{x:(box.x-rect.x)*w,y:(box.y-rect.y)*h,width:Math.max(box.width*w,12),height:Math.max(box.height*h,12)},textStyle:{fontPoints:parseFloat(style.fontSize)/12700,fontFamily:style.fontFamily.slice(0,100),bold:parseInt(style.fontWeight)>=600,color:color?'#'+color.slice(1).map(x=>Number(x).toString(16).padStart(2,'0')).join(''):'#222222',backgroundColor:'#ffffff',margins:[0,0,0,0]}}
      })
      setGeometry({slideId:slide.id,href:visible.href,elements})
    }
    measure();const observer=new ResizeObserver(measure);observer.observe(host.current)
    globalThis.document.fonts?.ready?.then?.(measure)
    return ()=>observer.disconnect()
  },[visible?.href])
  useEffect(()=>{
    if(!host.current)return
    for(const node of host.current.querySelectorAll('[data-wtt-selected]'))node.removeAttribute('data-wtt-selected')
    if(selectedId)for(const node of host.current.querySelectorAll('[data-wtt-svg-id]'))if(node.getAttribute('data-wtt-svg-id')===selectedId)node.setAttribute('data-wtt-selected','true')
  },[selectedId,visible?.href])
  const page=geometry?.slideId===slide?.id?{...slide,elements:slide.elements.map(e=>({...geometry.elements.find(g=>g.id===e.id),...e,bounds:geometry.elements.find(g=>g.id===e.id)?.bounds,textStyle:geometry.elements.find(g=>g.id===e.id)?.textStyle}))}:null
  return <div className={`wtt-ppt-page-wrap${showBounds?' show-object-bounds':''}`}><div className="wtt-ppt-page wtt-svg-page" style={{aspectRatio:`${document.width} / ${document.height}`}} aria-label={`第 ${slide?.number||1} 页SVG预览`}>
    <div ref={host} className={`wtt-svg-page-art${onObjectSelect?' is-selectable':''}`} aria-hidden="true" onClick={event=>{const target=event.target.closest?.('[data-wtt-svg-id]');const objectId=target?.getAttribute('data-wtt-svg-id');if(objectId&&objectId!=='n')onObjectSelect?.(objectId)}} dangerouslySetInnerHTML={{__html:visible?.markup||''}} />
    {!visible&&<div className="wtt-ppt-page-empty" role="status">正在读取源稿…</div>}
    {!readOnly&&visible&&page&&marks&&[...marks.entries()].map(([id,n])=>{const el=page.elements.find(e=>e.id===id);if(!el)return null;const base=pptObjectStyle(document,el);if(!base)return null;return <span key={id} className={`wtt-svg-badge${selectedId===id?' is-active':''}`} style={{left:base.left,top:base.top}}>{n}</span>})}
    {!readOnly&&visible&&page&&plus&&(()=>{const el=page.elements.find(e=>e.id===plus.id);if(!el)return null;const base=pptObjectStyle(document,el);if(!base)return null;const corner=`calc(${parseFloat(base.left)+parseFloat(base.width)}%)`;return <UiButton variant="custom" className={`wtt-svg-plus${plus.active?' is-on':''}`} style={{left:corner,top:base.top}} aria-label={plus.active?'移出引用':'加入引用'} onClick={event=>{event.stopPropagation();onPlusToggle?.(plus.id)}}>{plus.active?'−':'＋'}</UiButton>})()}
    {!readOnly&&visible&&page&&<PptTextLayer key={slide.id} document={document} slide={page} renderedSlide={visible.renderedSlide} {...{selectedId,onSelect,onEdit,onCommit,onEditingChange,disabled}} />}
  </div></div>
}
