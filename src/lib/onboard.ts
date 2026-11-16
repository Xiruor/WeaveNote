import { prisma } from "@/lib/prisma";

/**
 * 欢迎笔记正文（Markdown）。注册成功后作为笔记库里的第一篇笔记出现，
 * 不依赖任何模板表。
 */
const WELCOME_NOTE_CONTENT = `你好，欢迎来到**织念 WeaveNote**。

织念是一个与 AI 共笔的沉浸式笔记库：写作与思考是主线，AI 是坐在你旁边的合作者。开始之前，先记住三件事——

## 1. 直接开写，自动保存

新建一篇笔记，敲下第一个字就好。内容会自动保存，不怕中途关掉页面，也不需要手动存档。想到哪写到哪，剩下的交给织念。

## 2. 随时向 AI 提问，看得见来源

右侧的 AI 面板可以就**当前笔记**或**全部笔记**回答问题，并标注引用来源——是哪篇笔记的哪一段，都能点回去核对。问一句「我上周写了什么」，它会替你翻遍整个笔记库。

## 3. AI 帮你整理，改动先看 diff

AI 会主动帮你梳理结构、润色表达，但每一处改动都会先给出 diff，等你确认后才落笔——你的笔记永远由你说了算。它也会慢慢记住你的偏好，越用越懂你。

---

现在就随便写点什么吧：一段想法、一个待办、一句摘抄都可以。

念头值得被好好织起来。祝你写得开心。
`;

/**
 * 注册瞬间：给新用户创建一条欢迎笔记。
 * 失败只打日志不抛错，绝不影响注册本身。
 */
export async function cloneWelcomeNote(userId: string): Promise<void> {
  try {
    await prisma.note.create({
      data: {
        userId,
        title: "欢迎使用织念",
        content: WELCOME_NOTE_CONTENT,
      },
    });
  } catch (e) {
    console.error("[onboard] 创建欢迎笔记失败:", e);
  }
}
