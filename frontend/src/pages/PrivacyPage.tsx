import { Link } from "react-router-dom";
import { AuthShell } from "../components/AuthShell";

/** What Synapse stores, where, and how to delete it. Plain description of how the app actually works. */
export function PrivacyPage() {
  return (
    <AuthShell wide>
      <h1>Privacy</h1>
      <p className="muted">How Synapse handles your notes and your account.</p>

      <h2>What Synapse stores</h2>
      <ul>
        <li>Your email address and a hashed password. Sign-in is handled by Amazon Cognito; Synapse never sees your password.</li>
        <li>The notes and quiz files you upload. Uploaded files are deleted automatically after 30 days.</li>
        <li>What Synapse extracts from your notes: concepts, how they connect, short summaries and the explanations it generates for you.</li>
        <li>Your review and quiz history (scores and timestamps) and the memory estimates calculated from it.</li>
        <li>A short learner profile that summarises how you are doing, used to tailor explanations and quizzes.</li>
        <li>The semester label you type when you add a course, if you give one.</li>
      </ul>

      <h2>Where it is processed</h2>
      <ul>
        <li>Amazon Web Services (us-east-2): sign-in, file storage, the application itself, and text recognition (Amazon Textract) for photos and PDFs.</li>
        <li>MongoDB Atlas: your courses, concepts and links.</li>
        <li>Tiger Data: your review history.</li>
        <li>Supermemory: your learner profile.</li>
        <li>Google Gemini API: the text of your notes and the concept names are sent to it to extract concepts and write explanations and quizzes. Google&rsquo;s terms for that service apply to that processing.</li>
      </ul>

      <h2>What Synapse does not do</h2>
      <ul>
        <li>No advertising, no analytics trackers and no selling of data.</li>
        <li>Your browser keeps only what is needed to stay signed in and to remember light or dark mode.</li>
        <li>Your email is used to sign you in and to send confirmation and password-reset codes, nothing else.</li>
      </ul>

      <h2>Deleting your data</h2>
      <p>
        Open <Link to="/app/account">Account</Link> and choose &ldquo;Delete account and data&rdquo;. This removes your courses, concepts, quiz and review
        history, uploaded files, learner profile and your login immediately. It cannot be undone. Anything Google has already processed
        under its own terms is outside Synapse&rsquo;s control.
      </p>

      <h2>Please note</h2>
      <p>Synapse is a student project with no uptime guarantee. Do not upload documents that contain sensitive personal information such as IDs, health or financial records.</p>
    </AuthShell>
  );
}
