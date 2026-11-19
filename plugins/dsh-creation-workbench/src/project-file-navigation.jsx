import {useCallback,useEffect,useRef,useState} from 'react'
import {remapProjectFilePath} from './project-file-paths.mjs'

export const projectFileParent=path=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):''

export function useProjectFileNavigation({projectId,active,refreshSignal,revealRequest,onLocated}){
  const [tree,setTree]=useState(()=>new Map())
  const [expanded,setExpanded]=useState(()=>new Set(['']))
  const [errors,setErrors]=useState(()=>new Map())
  const [searchOpen,setSearchOpen]=useState(false)
  const [query,setQuery]=useState('')
  const [composing,setComposing]=useState(false)
  const [search,setSearch]=useState(null)
  const [searchRefresh,setSearchRefresh]=useState(0)
  const [locating,setLocating]=useState(false)
  const [navigationError,setNavigationError]=useState('')
  const treeRef=useRef(tree)
  treeRef.current=tree
  const expandedRef=useRef(expanded)
  expandedRef.current=expanded
  const requests=useRef(new Map())
  const navigation=useRef(null)
  const searchRequest=useRef(null)
  const handled=useRef(null)

  const read=useCallback(async(params,signal)=>{
    const url=new URL('api/wtt-creation-workbench',document.baseURI)
    url.searchParams.set('projectId',projectId)
    for(const [name,value] of Object.entries(params))url.searchParams.set(name,value)
    const response=await fetch(url,{credentials:'same-origin',signal})
    const data=await response.json()
    if(!response.ok)throw Object.assign(new Error(data.error||'项目文件读取失败'),{status:response.status})
    return data
  },[projectId])

  const load=useCallback(async(path='',{offset,around,append=false}={})=>{
    requests.current.get(path)?.abort()
    const controller=new AbortController()
    requests.current.set(path,controller)
    setErrors(current=>{
      if(!current.has(path))return current
      const next=new Map(current)
      next.delete(path)
      return next
    })
    try{
      const page=await read({projectFilesPage:path,...(offset!==undefined?{offset}:{}),...(around?{around}:{})},controller.signal)
      if(controller.signal.aborted)return null
      setTree(current=>{
        const old=current.get(path)
        const next=new Map(current)
        if(!append||!old||old.revision!==page.revision)return next.set(path,page)
        const before=page.offset<old.offset
        const entries=[...new Map((before?[...page.entries,...old.entries]:[...old.entries,...page.entries]).map(entry=>[entry.path,entry])).values()]
        return next.set(path,{...page,entries,offset:before?page.offset:old.offset,
          previousOffset:before?page.previousOffset:old.previousOffset,nextOffset:before?old.nextOffset:page.nextOffset})
      })
      return page
    }catch(cause){
      if(controller.signal.aborted)return null
      if(cause.status===404&&path){
        setTree(current=>new Map([...current].filter(([key])=>key!==path&&!key.startsWith(path+'/'))))
      }
      setErrors(current=>new Map(current).set(path,cause.message))
      return null
    }finally{
      if(requests.current.get(path)===controller)requests.current.delete(path)
    }
  },[read])

  useEffect(()=>{
    if(!active)return
    setLocating(false)
    void load()
    const pending=requests.current
    return ()=>{
      navigation.current=null
      for(const controller of pending.values())controller.abort()
      pending.clear()
    }
  },[active,load])

  const refresh=useCallback(async()=>{
    if(navigation.current)return
    const paths=[...expandedRef.current].filter(path=>{
      for(let parent=projectFileParent(path);parent;parent=projectFileParent(parent)){
        if(!expandedRef.current.has(parent))return false
      }
      return true
    })
    const next=paths.values()
    async function worker(){
      for(const path of next){
        if(navigation.current)return
        await load(path,{offset:treeRef.current.get(path)?.offset})
      }
    }
    await Promise.all(Array.from({length:Math.min(paths.length,4)},worker))
  },[load])

  useEffect(()=>{
    if(!active)return
    const changed=()=>void refresh()
    window.addEventListener('focus',changed)
    return ()=>window.removeEventListener('focus',changed)
  },[active,refresh])
  useEffect(()=>{if(active&&refreshSignal)void refresh()},[refreshSignal])

  const showDirectory=useCallback(path=>{
    setExpanded(current=>new Set([...current,path]))
    if(!treeRef.current.has(path))void load(path)
  },[load])

  const toggleDirectory=useCallback((path,open)=>{
    if(open)showDirectory(path)
    else setExpanded(current=>new Set([...current].filter(key=>key!==path)))
  },[showDirectory])

  const locate=useCallback(async path=>{
    const intent=Symbol()
    navigation.current=intent
    setLocating(true)
    setNavigationError('')
    try{
      const segments=path.split('/')
      let parent=''
      for(const [index,segment] of segments.entries()){
        const child=parent?parent+'/'+segment:segment
        const page=treeRef.current.get(parent)
        const cached=index<segments.length-1&&page?.entries.some(entry=>entry.path===child)
        const branch=cached?page:await load(parent,{around:child})
        if(navigation.current!==intent)return
        if(!branch?.entries.some(entry=>entry.path===child))throw new Error('找不到该文件，可能已移动或删除。')
        parent=child
      }
      const ancestors=segments.slice(0,-1).map((_,i)=>segments.slice(0,i+1).join('/'))
      setExpanded(current=>new Set([...current,...ancestors]))
      setSearchOpen(false)
      setQuery('')
      onLocated(path)
    }catch(cause){
      if(navigation.current===intent)setNavigationError(cause.message)
    }finally{
      if(navigation.current===intent){navigation.current=null;setLocating(false)}
    }
  },[load,onLocated])

  useEffect(()=>{
    if(active&&revealRequest&&handled.current!==revealRequest.token){
      handled.current=revealRequest.token
      void locate(revealRequest.path)
    }
  },[active,revealRequest,locate])

  useEffect(()=>{
    if(!active||!searchOpen||!query.trim()||composing)return
    const controller=new AbortController()
    searchRequest.current=controller
    const timer=setTimeout(async()=>{
      try{
        const result=await read({projectFileSearch:query,...(searchRefresh?{refresh:'1'}:{})},controller.signal)
        if(!controller.signal.aborted)setSearch({...result,query,refresh:searchRefresh})
      }catch(cause){
        if(!controller.signal.aborted)setSearch({error:cause.message,query,refresh:searchRefresh})
      }
    },100)
    return ()=>{clearTimeout(timer);controller.abort()}
  },[active,searchOpen,query,composing,searchRefresh,read])

  function editQuery(value){
    searchRequest.current?.abort()
    navigation.current=null
    setLocating(false)
    setSearchRefresh(0)
    setSearch(null)
    setQuery(value)
    setNavigationError('')
  }

  async function filesOrganized(changes){
    const affected=new Set(changes.flatMap(item=>[item.from,item.to].filter(Boolean).map(projectFileParent)))
    setExpanded(current=>new Set([...current].map(path=>remapProjectFilePath(path,changes)).filter(path=>path!==null)))
    setTree(current=>{
      const mapped=new Map()
      for(const [path,page] of current){
        const next=remapProjectFilePath(path,changes)
        if(next===null)continue
        mapped.set(next,next===path?page:{...page,path:next,entries:page.entries.map(entry=>({...entry,path:remapProjectFilePath(entry.path,changes)}))})
      }
      return mapped
    })
    await Promise.all([...affected].filter(path=>treeRef.current.has(path)).map(path=>load(path,{offset:treeRef.current.get(path)?.offset})))
  }

  return {tree,expanded,errors,searchOpen,setSearchOpen,query,editQuery,setComposing,locating,
    search:search?.query===query&&search.refresh===searchRefresh?search:null,navigationError,
    locate,load,refresh,showDirectory,toggleDirectory,filesOrganized,collapse:()=>setExpanded(new Set([''])),
    refreshSearch:()=>setSearchRefresh(value=>value+1)}
}
