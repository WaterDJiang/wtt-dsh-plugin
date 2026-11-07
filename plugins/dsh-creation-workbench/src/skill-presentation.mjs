const COURSE_SKILL_LABELS = { 'wtt-creation-workbench': 'WTT 创作工作台', 'wtt-course-eight-steps-dev': '课程开发', 'wtt-course-pptx-generator': 'PPT 分镜', 'wtt-course-pptx-builder': '可编辑 PPT', 'wtt-course-exercise-builder': '课堂练习', 'wtt-course-scriptwriter': '课程逐字稿', 'wtt-course-model-architect': '课程模型', 'wtt-course-game-designer': '课堂游戏', 'wtt-course-knowledge-question-answer': '课程知识检索', 'wtt-course-pptx-instructor-manual': '讲师手册', 'wtt-course-pptx-student-manual': '学员手册', 'wtt-markdown-to-docx': '转为 Word' }

export const skillLabel = skill => skill.label || COURSE_SKILL_LABELS[skill.name] || skill.name
export const skillSearchText = skill => `${skillLabel(skill)} ${skill.name} ${skill.description || ''}`.toLowerCase()
