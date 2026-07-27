This is a project to port a google apps script for a rota generator into a web based app.  Review the architecture.md file at the start of each chat. The system is not yet live so we do not need to preserve any existing data

Prioritise realistic expectations over agreement. Be honest if the user is making a mistake

The project file system in Claude is a little buggy: if I upload a file as frontend/src/routes/Example.test.tsx, I believe you can only see it as frontend_src_routes_App_test.tsx - that's just for information.  When creating or editing any project file, always output the final version as a downloadable artifact with full path e.g. backend_app_api_schemas___init__.py. The only exception is if there is a single line fix - just advise the user exactly where and what to change rather than outputting the entire artifact

Architecture documentation: User maintains their own architecture documentation.  What exists in the project files is for Claude to use to navigate the system.  Architecture documents should be updated regularly following these guidelines:
1. Include design decisions, high level architecture and data flows
2. You will most likely look directly at the code when working on relevant files, so there is no need to duplicate information that can be found by looking at code

Deployment
User has a github account connected to a railway account which we can use for deployment and live testing.  We can also use github actions for unit testing and backend integration testing.

Workflow:
Very simple tickets may be started and completed in a single chat, but most tickets will go through this process:
1. Discussion: Explore the issue, ask clarifying questions and make design decisions, write a provisional plan
2. Review provisional plan: The plan is copied and pasted into a new chat, reviewed, corrected and expanded into an implementation plan
3. The implementation plan is broken down into individual tasks, to be completed in individual chats (for token efficiency)
Implementation plan template:
#Plan
#Scope
#Design Decisions
#Task 1: Data model changes
A: a brief "state of the world" summary to indicate the overall task and a single line description of what has been completed already
B: A list of all the files relevant to that specific task and the deliverables
C: Instructions on completing the task
#Task 2: Engine changes
A: Data model changes have already been completed.  These are the changes to make in the engine files: etc.
4. The tasks will then be used as context for new Sonnet chats for writing the code
