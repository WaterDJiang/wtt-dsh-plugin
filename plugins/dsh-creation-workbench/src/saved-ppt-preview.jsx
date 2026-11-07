import React,{useEffect,useState} from 'react'
import {UserError} from './user-feedback.jsx'

export function SavedPptPreview({scope,endpoint,renderNativePreview}){
  const [source,setSource]=useState(null),[error,setError]=useState('');
  const identity=JSON.stringify([scope.artifactId,scope.hash,scope.requirementId]);
  useEffect(()=>{let live=true;setSource(null);setError('');if(!scope.artifactId)return;fetch(endpoint({nativePreview:`artifact:${scope.artifactId}`,requirementId:scope.requirementId,hash:scope.hash}),{credentials:'same-origin'}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.error||'已保存PPT预览未能打开');if(live)setSource(value)}).catch(cause=>{if(live)setError(cause.message)});return()=>{live=false}},[identity]);
  return <section className="wtt-saved-ppt-preview" aria-label="已保存PPT预览">{error?<UserError error={error}/>:source?renderNativePreview?.(source)||<UserError error="DSH原生预览未连接"/>:<p role="status">{scope.artifactId?'正在打开已保存PPT预览…':'尚未保存PPT，请先编辑源稿并保存新版本。'}</p>}</section>
}
