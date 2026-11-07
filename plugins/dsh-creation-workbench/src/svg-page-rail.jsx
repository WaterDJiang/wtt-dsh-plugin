import React,{useEffect,useRef} from 'react'
import {UiButton} from './ui/controls.jsx'

export function SvgPageRail({document,pageId,pageHref,onSelect}){
  const rail=useRef(null),[failed,setFailed]=React.useState({})
  useEffect(()=>{rail.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'nearest'})},[pageId])
  return <nav ref={rail} className="wtt-svg-page-rail" aria-label="逐页预览">
    {document.slides.map((page,index)=><UiButton key={page.id} variant="custom" className="wtt-svg-thumbnail" aria-current={page.id===pageId?'page':undefined} aria-label={`第${index+1}页：${page.title||'未命名页'}`} title={page.title} onClick={()=>onSelect(page.id)}>
      <span className="wtt-svg-thumbnail-image" style={{aspectRatio:`${document.width}/${document.height}`}}>{failed[pageHref(page)]?<span>预览暂不可用</span>:<img src={pageHref(page)} alt="" loading="lazy" decoding="async" onError={()=>setFailed(previous=>({...previous,[pageHref(page)]:true}))}/>}</span><span>{index+1}</span>
    </UiButton>)}
  </nav>
}
