// The quiz flow, shared by the node popup and the Guide entry page. It opens as a
// side drawer so the graph stays visible and the node can be seen changing when
// the result comes back. Copy is verbatim from COPY.md.
//
//   Take quiz -> "Have a Canvas quiz for this concept?"
//     No  -> full generated quiz (10 questions)
//     Yes -> upload -> parsed:      success line, then a short quiz
//                   -> parseFailed: no error shown, straight to the full quiz
import { useEffect, useRef, useState } from "react";
import { api, ApiRequestError, contentTypeOf, uploadFile } from "../api";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  type QuizGenerateResponse,
  type QuizMode,
  type QuizSubmitResponse,
} from "../contracts";
import { confidenceText, pct } from "../lib/format";
import { useData } from "../state/data";

type Step =
  | { name: "ask" }
  | { name: "upload" }
  | { name: "working"; text: string }
  | { name: "quiz"; quiz: QuizGenerateResponse }
  | { name: "submitting"; quiz: QuizGenerateResponse }
  | { name: "results"; quiz: QuizGenerateResponse; result: QuizSubmitResponse }
  | { name: "error"; text: string; retry: () => void };

const LETTERS = ["A", "B", "C", "D"];

export function QuizDrawer({ conceptId, label, onClose }: { conceptId: string; label: string; onClose: () => void }) {
  const { applyNode } = useData();
  const [step, setStep] = useState<Step>({ name: "ask" });
  const [uploadedOk, setUploadedOk] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const live = useRef(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    live.current = true;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      live.current = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [step.name]);

  const fail = (e: unknown, retry: () => void) => {
    if (!live.current) return;
    setStep({ name: "error", text: e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.", retry });
  };

  const generate = async (mode: QuizMode) => {
    setStep({ name: "working", text: mode === "full" ? "Writing your 10 questions…" : "Writing a few quick questions…" });
    setAnswers({});
    try {
      const quiz = await api.generateQuiz(conceptId, mode);
      if (live.current) setStep({ name: "quiz", quiz });
    } catch (e) {
      fail(e, () => void generate(mode));
    }
  };

  const pickFile = (f: File | null) => {
    setFileError(null);
    setFile(null);
    if (!f) return;
    if (!ALLOWED_UPLOAD_TYPES.quiz.includes(contentTypeOf(f))) return setFileError("That file type isn't supported. Use PDF, PNG, JPG or TXT.");
    if (f.size > MAX_UPLOAD_BYTES) return setFileError("That file is over 10 MB.");
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setStep({ name: "working", text: "Reading your quiz…" });
    try {
      const s3Key = await uploadFile(api, file, "quiz");
      const res = await api.uploadQuiz(conceptId, { s3Key });
      if (!live.current) return;
      if (res.parseFailed) {
        // By contract: no error, carry on as if the user had clicked "No, quiz me".
        void generate("full");
        return;
      }
      applyNode(res.node);
      setUploadedOk(true);
      void generate("short");
    } catch (e) {
      fail(e, () => setStep({ name: "upload" }));
    }
  };

  const submit = async (quiz: QuizGenerateResponse) => {
    setStep({ name: "submitting", quiz });
    try {
      const result = await api.submitQuiz(conceptId, {
        quizId: quiz.quizId,
        answers: quiz.questions.map((q) => ({ questionId: q.id, selectedIndex: answers[q.id] ?? null })),
      });
      applyNode(result.node); // the node's ring and fill change on the graph right now
      if (live.current) setStep({ name: "results", quiz, result });
    } catch (e) {
      fail(e, () => setStep({ name: "quiz", quiz }));
    }
  };

  const quiz = step.name === "quiz" || step.name === "submitting" || step.name === "results" ? step.quiz : null;
  const result = step.name === "results" ? step.result : null;
  const answered = quiz ? quiz.questions.filter((q) => answers[q.id] !== undefined).length : 0;

  return (
    <aside className="drawer" role="dialog" aria-label={`Quiz: ${label}`}>
      <header className="drawer-head">
        <div>
          <p className="eyebrow">Quiz</p>
          <h2>{label}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close quiz">
          <svg width="16" height="16" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2 2l10 10M12 2 2 12" />
          </svg>
        </button>
      </header>

      <div className="drawer-body" ref={bodyRef}>
        {uploadedOk && step.name !== "results" && step.name !== "error" && (
          <p className="note note-ok" role="status">
            Got your quiz. A few quick questions to confirm.
          </p>
        )}

        {step.name === "ask" && (
          <div className="quiz-ask">
            <h3>Have a Canvas quiz for this concept?</h3>
            <div className="btn-stack">
              <button className="btn" onClick={() => setStep({ name: "upload" })}>
                Yes, upload it
              </button>
              <button className="btn btn-primary" onClick={() => void generate("full")}>
                No, quiz me
              </button>
            </div>
          </div>
        )}

        {step.name === "upload" && (
          <div className="quiz-upload">
            <h3>Have a Canvas quiz for this concept?</h3>
            <label className="file-pick">
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.txt,application/pdf,image/png,image/jpeg,text/plain"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p className="disclaimer">Upload a Canvas/Gradescope export — handwritten quiz photos are coming in a future update</p>
            {fileError && (
              <p className="note note-error" role="alert">
                {fileError}
              </p>
            )}
            <div className="btn-row">
              <button className="btn" onClick={() => setStep({ name: "ask" })}>
                Back
              </button>
              <button className="btn btn-primary" disabled={!file} onClick={() => void upload()}>
                Upload quiz
              </button>
            </div>
          </div>
        )}

        {step.name === "working" && (
          <div className="working" role="status">
            <span className="spinner" aria-hidden="true" />
            {step.text}
          </div>
        )}

        {step.name === "error" && (
          <div className="quiz-ask">
            <p className="note note-error" role="alert">
              {step.text}
            </p>
            <button className="btn" onClick={step.retry}>
              Try again
            </button>
          </div>
        )}

        {result && quiz && (
          <div className="result-card">
            <div className="result-score">{pct(result.score)}</div>
            <div>
              <strong>
                {result.pointsEarned} of {result.totalPoints} points
              </strong>
              <p>
                Confidence is now <strong>{confidenceText(result.node.confidence)}</strong>.{" "}
                {result.node.retention >= 0.95
                  ? `Retention is back to ${pct(result.node.retention)}.`
                  : `Retention is now ${pct(result.node.retention)} because the score was low, so this concept needs another look.`}
              </p>
            </div>
          </div>
        )}

        {quiz && (
          <ol className="questions">
            {quiz.questions.map((q, qi) => {
              const r = result?.results.find((x) => x.questionId === q.id);
              const picked = answers[q.id];
              return (
                <li key={q.id} className="question">
                  <div className="question-head">
                    <span className="q-num">Question {qi + 1}</span>
                    <span className="q-points">
                      {q.points} {q.points === 1 ? "point" : "points"}
                    </span>
                  </div>
                  <p className="q-prompt">{q.prompt}</p>
                  <div className="options" role="radiogroup" aria-label={`Question ${qi + 1}`}>
                    {q.options.map((opt, oi) => {
                      const isPicked = picked === oi;
                      const cls = ["option"];
                      if (isPicked) cls.push("option-picked");
                      if (r && oi === r.correctIndex) cls.push("option-correct");
                      if (r && isPicked && !r.correct) cls.push("option-wrong");
                      return (
                        <button
                          key={oi}
                          type="button"
                          role="radio"
                          aria-checked={isPicked}
                          className={cls.join(" ")}
                          disabled={step.name !== "quiz"}
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: oi }))}
                        >
                          <span className="option-letter">{LETTERS[oi]}</span>
                          <span className="option-text">{opt}</span>
                          {r && oi === r.correctIndex && <span className="option-tag">Correct answer</span>}
                          {r && isPicked && !r.correct && <span className="option-tag">Your answer</span>}
                        </button>
                      );
                    })}
                  </div>
                  {r && (
                    <div className={r.correct ? "verdict verdict-ok" : "verdict verdict-bad"}>
                      <strong>
                        {r.correct ? "✓ Correct" : picked === undefined ? "✗ Not answered" : "✗ Incorrect"}
                        {" · "}
                        {r.correct ? q.points : 0}/{q.points}
                      </strong>
                      <p>{r.explanation}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {quiz && step.name !== "results" && (
        <footer className="drawer-foot">
          <span className="muted">
            {answered} of {quiz.questions.length} answered · {quiz.totalPoints} points
          </span>
          <button className="btn btn-primary" disabled={step.name === "submitting" || answered === 0} onClick={() => void submit(quiz)}>
            {step.name === "submitting" ? "Grading…" : "Submit quiz"}
          </button>
        </footer>
      )}
      {step.name === "results" && (
        <footer className="drawer-foot">
          <span className="muted">The map has been updated.</span>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      )}
    </aside>
  );
}
