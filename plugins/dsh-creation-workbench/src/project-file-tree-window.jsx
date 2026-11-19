import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react'

const overscanRows=8
const windowThreshold=120

function firstAt(rows,pixel){
  let left=0,right=rows.length
  while(left<right){
    const middle=Math.floor((left+right)/2)
    if(rows[middle].end<=pixel)left=middle+1
    else right=middle
  }
  return left
}

export function fileTreeRows(tree,expanded,errors,createParent){
  const rows=[],entries=[]
  function branch(parent,level){
    const page=tree.get(parent)
    const control=(kind,extra)=>rows.push({key:kind+':'+parent,kind,parent,level,...extra})
    if(createParent===parent)control('create')
    const error=errors.get(parent)
    if(error)control('error',{error,offset:page?.offset})
    else if(!page)control('loading')
    if(page?.previousOffset!=null)control('previous',{offset:page.previousOffset})
    for(const [index,entry] of (page?.entries||[]).entries()){
      entries.push(entry)
      rows.push({key:'entry:'+entry.path,kind:'entry',entry,level,position:page.offset+index+1,total:page.total})
      if(entry.directory&&expanded.has(entry.path))branch(entry.path,level+1)
    }
    if(page?.entries.length===0&&createParent!==parent)control('empty')
    if(page?.nextOffset!=null)control('next',{offset:page.nextOffset})
  }
  branch('',1)
  return {rows,entries}
}

export function useFileTreeWindow(rows,{visible,editing,pinned}){
  const treeElement=useRef(null)
  const frame=useRef(null)
  const [viewport,setViewport]=useState({top:0,height:0,mobile:false})
  const sync=useCallback(()=>{
    const tree=treeElement.current
    if(!tree)return
    const next={top:tree.scrollTop,height:tree.clientHeight,mobile:matchMedia('(max-width:700px)').matches}
    setViewport(current=>current.top===next.top&&current.height===next.height&&current.mobile===next.mobile?current:next)
  },[])
  useLayoutEffect(()=>{
    if(!visible)return
    sync()
    const observer=new ResizeObserver(sync)
    observer.observe(treeElement.current)
    return ()=>{
      observer.disconnect()
      if(frame.current!==null)cancelAnimationFrame(frame.current)
      frame.current=null
    }
  },[sync,visible])
  function onScroll(){
    if(frame.current!==null)return
    frame.current=requestAnimationFrame(()=>{frame.current=null;sync()})
  }

  const rowHeight=viewport.mobile?40:30
  const layout=useMemo(()=>{
    const byKey=new Map()
    if(!visible)return {positioned:[],height:0,byKey}
    let height=0
    const positioned=rows.map((row,index)=>{
      const top=height
      const area=row.kind==='entry'&&row.entry.path!==editing?rowHeight:rowHeight+(viewport.mobile?8:10)
      height+=area
      const box={...row,index,top,height:area,end:height}
      byKey.set(row.key,box)
      return box
    })
    return {positioned,height,byKey}
  },[rows,rowHeight,viewport.mobile,editing,visible])
  const items=useMemo(()=>{
    if(!visible)return []
    const {positioned,byKey}=layout
    if(positioned.length<=windowThreshold)return positioned
    const buffer=rowHeight*overscanRows
    const start=firstAt(positioned,Math.max(0,viewport.top-buffer))
    const stop=firstAt(positioned,viewport.top+Math.max(viewport.height,360)+buffer)
    const shown=new Map(positioned.slice(start,stop+1).map(row=>[row.key,row]))
    for(const key of pinned){
      const row=byKey.get(key)
      if(row)shown.set(key,row)
    }
    return [...shown.values()].sort((a,b)=>a.index-b.index)
  },[visible,layout,rowHeight,viewport.top,viewport.height,pinned])
  const reveal=useCallback(key=>{
    const tree=treeElement.current
    const row=layout.byKey.get(key)
    if(!tree||!row)return false
    const top=tree.scrollTop
    const bottom=top+tree.clientHeight
    if(row.top<top)tree.scrollTop=row.top
    else if(row.end>bottom)tree.scrollTop=row.end-tree.clientHeight
    sync()
    return true
  },[layout,sync])

  return {treeElement,items,height:layout.height,onScroll,reveal}
}
