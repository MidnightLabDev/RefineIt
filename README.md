<div align="center">
  
# Refine It!

</div>
 <div align="center">
    
Browser extension that rewrites any text instantly for Clarity, Tone & Flow.

Highlight any text in any text box; email, comment, doc, ticket, anything and a small bubble appears right above your selection. You click one button. The text rewrites itself in place. Done.

No tab switching. No copy-pasting. No leaving the page.

<img width="2752" height="1536" alt="refine-it-teaser" src="https://github.com/user-attachments/assets/0bfce63f-6c64-4b25-8fde-79b20819a166" />
</div>


## The problem

Every time I needed to fix a sentence in Gmail, polish a comment on GitHub, or clean up a Jira ticket, I had to copy the text, open ChatGPT, paste it, wait, copy back, and paste again.

That's 6 steps for something that should take 1.


## Here's everything it can do

1. **Six rewrite modes**: Fix grammar · Improve clarity · Shorten · Polish · Professional · Friendly

2. **Custom instructions**: Type anything: "Make it sound like a senior engineer wrote this" or "Cut it to one sentence." The AI follows exactly.

3. **Language auto-detect**: Write in French, Arabic, Spanish, or any language. The rewrite comes back in the same language automatically.

4. **Context-aware rewriting**: The AI reads the sentences before and after your selection so it understands the tone and intent before touching your text.

5. **Bold & Italic from the bubble**: Format your text directly from the floating bubble without opening the popup.

6. **Rewrite history**: Every rewrite this session is saved. Click the clock icon in the bubble to browse and restore any previous version.

7. **Usage & token tracker**: See exactly how many rewrites and tokens you've used this session and all-time, right in the popup.

8. **Platform-aware actions**: This is my favourite new feature. The extension detects which site you're on and adds context-specific buttons to the bubble:

    → On **GitHub**: Bug report · PR description · Action items

    → On **Jira**: Bug report · User story · Action items

    → On **Notion**: Action items · Structure it · TL;DR

So if you're writing a GitHub comment and you highlight some rough notes, you can hit "Bug report" and it rewrites them into a properly structured report with Summary, Steps to Reproduce, Expected vs Actual Behavior, instantly.

## How to install

1. Download the ZIP from the link in the comments
2. Unzip it to a folder on your computer
3. Open Chrome and go to `chrome://extensions`
4. Turn on **Developer mode** (toggle in the top-right)
5. Click **Load unpacked** and select the unzipped folder
6. The Refine It! icon will appear in your toolbar

First time? The extension will walk you through a 3-step onboarding to pick your AI provider and paste your API key. Takes about 30 seconds.

## Your key, your data

Refine It! uses your own API key: OpenRouter (free models available), ChatGPT, or Google Gemini. Nothing is stored on any server. Your text goes directly from your browser to the AI provider and back. That's it.

## How to get your OpenAI API key
1. Go to https://platform.openai.com
2. Sign in or create an account
3. Go to “API Keys” section
4. Click “Create new secret key”
5. Copy and paste it into Refine It

## How to get your OpenRouter API key
1. Go to https://openrouter.ai/workspaces/default/keys
2. Sign in to your OpenRouter account
3. Create a new API key
4. Give the key a name, and optionally set a credit limit
5. Copy and paste it into Refine It

## How to get your Gemini API key
1. Go to Google AI Studio https://aistudio.google.com/api-keys
2. Sign in with your Google account
3. Create a new Gemini API key
4. If prompted, choose an existing Google Cloud project or create a new one
5. Copy and paste it into Refine It

## How to use it

1. Go to any website with a text field (Gmail, GitHub, Notion, LinkedIn, anywhere)
2. Click inside the text box and type or paste some text
3. Highlight the words you want to rewrite
4. A bubble appears above your selection, pick a mode or type a custom instruction
5. The text rewrites itself in place

That's the whole flow. No popups, no tab switching, no friction.

Built this because I was tired of the copy-paste loop. Now I use it every day for emails, PR descriptions, and Slack messages.

