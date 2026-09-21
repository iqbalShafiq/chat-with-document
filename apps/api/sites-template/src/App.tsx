const SECTIONS = ["hero", "features", "contact"] as const;

export default function App() {
  return (
    <main>
      {SECTIONS.map((section) => (
        <section key={section} data-section={section}>
          <h2>{section}</h2>
          <p>Replace this starter copy with real content from the brief.</p>
        </section>
      ))}
    </main>
  );
}
