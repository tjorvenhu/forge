import { getLocale } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";

export default async function NotFound() {
  const { t } = i18n(await getLocale());
  return (
    <main className="container content">
      <div className="intro">
        <h1>{t.notFound.title}</h1>
        <p>{t.notFound.text}</p>
      </div>
      <div>
        <a className="btn btn-outline" href="/">
          {t.notFound.back}
        </a>
      </div>
    </main>
  );
}
