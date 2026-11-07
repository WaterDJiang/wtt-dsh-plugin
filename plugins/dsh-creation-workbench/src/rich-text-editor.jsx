import { UiButton } from './ui/controls.jsx'
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import './rich-text-editor.css'

// Keep uncommon Markdown in source mode rather than silently simplifying it.
const needsSource=value=>/<\/?[a-z][^>]*>|!\[[^\]]*\]\(|^\s*[-*]\s+\[[ x]\]|^\[\^[^\]]+\]:|^\$\$|^:::/im.test(value)
const plainDocument=value=>({type:'doc',content:value.split('\n').map(line=>({type:'paragraph',...(line?{content:[{type:'text',text:line}]}:{})}))})
export const RichTextEditor=forwardRef(function RichTextEditor({value,onChange,markdown=false,disabled=false,label='编辑正文'},ref){
  const latest=useRef({value,onChange});latest.current={value,onChange}
  const [source,setSource]=useState(()=>markdown&&needsSource(value))
  const editor=useEditor({extensions:[StarterKit,...(markdown?[TableKit,Markdown]:[])],content:markdown?value:plainDocument(value),...(markdown?{contentType:'markdown'}:{}),
    editable:!disabled,editorProps:{attributes:{role:'textbox','aria-label':label,'aria-multiline':'true',spellcheck:'false'}},
    onUpdate:({editor})=>latest.current.onChange(markdown?editor.getMarkdown():editor.getText({blockSeparator:'\n'})),
  })
  useImperativeHandle(ref,()=>({focus:()=>editor?.commands.focus()}),[editor])
  useEditorState({editor,selector:({editor})=>editor?`${editor.state.selection.from}:${editor.state.selection.to}:${editor.isActive('bold')}:${editor.isActive('heading')}:${editor.can().undo()}`:''})
  useEffect(()=>{editor?.setEditable(!disabled,false)},[editor,disabled])
  function switchMode(){
    if(source){editor.commands.setContent(latest.current.value,{contentType:'markdown',emitUpdate:false})}
    setSource(!source)
  }
  const command=(label,run,active=false)=><UiButton variant="custom" type="button" key={label} aria-pressed={active} disabled={disabled||!editor||source} onMouseDown={event=>event.preventDefault()} onClick={()=>run(editor.chain().focus()).run()}>{label}</UiButton>
  return <div className="wtt-rich-editor">
    <div className="wtt-rich-tools" role="toolbar" aria-label="正文格式">
      {command('撤销',chain=>chain.undo())}{command('重做',chain=>chain.redo())}
      {markdown&&<>{command('标题',chain=>chain.toggleHeading({level:2}),editor?.isActive('heading'))}{command('加粗',chain=>chain.toggleBold(),editor?.isActive('bold'))}{command('列表',chain=>chain.toggleBulletList(),editor?.isActive('bulletList'))}{command('表格',chain=>chain.insertTable({rows:3,cols:2,withHeaderRow:true}))}</>}
      {markdown&&<UiButton variant="custom" type="button" className="wtt-rich-source" disabled={disabled||(source&&needsSource(value))} title={source&&needsSource(value)?'此内容含复杂 Markdown，请保留源文编辑。':'切换 Markdown 源文与排版编辑'} onClick={switchMode}>{source?'排版':'源文'}</UiButton>}
    </div>
    {source?<textarea className="wtt-rich-raw" aria-label={`${label}（Markdown 源文）`} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>:<EditorContent editor={editor}/>}
  </div>
})
