/* Экран разблокировки и мок рекламы.

   Порог бесплатных серий взят из жанровой нормы: у DramaBox и Short Shot
   первые десять бесплатны, у типовых сборок три, у ReelShort около шести
   за просмотр рекламы в сутки. Точное число задаётся в content.json.

   Первой кнопкой стоит реклама, а не оплата: базовая модель — бесплатный
   доступ с рекламной выручкой, платёж идёт альтернативой. Отдельной строкой
   вынесено списание со счёта телефона — там, где у конкурентов обходные
   схемы сторов, это в один тап. */

window.Paywall = (function () {

  let content, state, cfg;
  let ctx = null;                 // что именно разблокируем
  let adTimer = null;

  const el = (id) => document.getElementById(id);
  const sheet = () => el('paywall');

  function init(opts) {
    content = opts.content;
    state   = opts.state;
    cfg     = (content.service && content.service.monetization) || {};

    el('payAllPrice').textContent = `${cfg.price} · один раз`;

    el('paywallClose').addEventListener('click', close);
    el('payAd').addEventListener('click', runAd);
    el('payAll').addEventListener('click', () => settle('all'));
    el('payPhone').addEventListener('click', () => settle('phone'));
  }

  /** Доступна ли серия с индексом i без оплаты. */
  function allowed(series, i) {
    if (!series || series.locked) return false;
    if (state.allAccess) return true;
    if (i < (cfg.freeEpisodes || 8)) return true;
    return (state.unlocked[series.id] || -1) >= i;
  }

  /**
   * @param seriesIndex  индекс сериала
   * @param episodeIndex индекс серии, упёршейся в порог; null — закрытый сериал
   * @param onUnlock     что сделать, когда доступ получен
   */
  function open(seriesIndex, episodeIndex, onUnlock) {
    const s = content.series[seriesIndex];
    ctx = { series: s, episodeIndex, onUnlock };

    el('paywallBg').style.backgroundImage = s.poster
      ? `url("${s.poster}"), linear-gradient(160deg, ${s.accent}, #101016)`
      : `linear-gradient(160deg, ${s.accent}, #101016)`;

    if (episodeIndex === null) {
      el('paywallTitle').textContent = s.title;
      el('paywallNote').textContent =
        `${s.genre} · ${s.episodeCount} серий. Сериал доступен по подписке.`;
      el('payAdNote').textContent = 'откроется первая серия';
    } else {
      const free = cfg.freeEpisodes || 8;
      el('paywallTitle').textContent = `Серия ${episodeIndex + 1} — дальше платно`;
      el('paywallNote').textContent =
        `Первые ${free} серий бесплатно. Смотреть дальше — по рекламе или подписке.`;
      el('payAdNote').textContent = 'откроется следующая серия';
    }

    sheet().classList.remove('is-done');
    sheet().hidden = false;
  }

  function close() {
    stopAd();
    sheet().hidden = true;
    ctx = null;
  }

  /* ── реклама ── */

  function runAd() {
    if (!ctx) return;
    const seconds = cfg.adSeconds || 5;
    let left = seconds;
    el('adCount').textContent = left;
    el('admock').hidden = false;

    adTimer = setInterval(() => {
      left -= 1;
      el('adCount').textContent = Math.max(0, left);
      if (left <= 0) {
        stopAd();
        el('admock').hidden = true;
        settle('ad');
      }
    }, 1000);
  }

  function stopAd() {
    if (adTimer) clearInterval(adTimer);
    adTimer = null;
  }

  /* ── выдача доступа ── */

  function settle(kind) {
    if (!ctx) return;
    const { series, episodeIndex, onUnlock } = ctx;

    // Реклама открывает одну серию, оплата — весь каталог.
    if (kind === 'ad') {
      if (episodeIndex !== null) {
        state.unlocked[series.id] = Math.max(state.unlocked[series.id] || -1, episodeIndex);
      }
    } else {
      state.allAccess = true;
    }
    state.save && state.save();

    // У сериалов-заглушек видео нет — открывать нечего, и делать вид,
    // что оно появилось, нельзя.
    if (series.locked) {
      // Оставлять кнопки после выдачи доступа нельзя — они предлагают
      // сделать то, что уже сделано.
      el('paywallTitle').textContent = 'Доступ открыт';
      el('paywallNote').textContent =
        'В прототипе видео загружено для четырёх сериалов — остальные показывают, как выглядит каталог.';
      sheet().classList.add('is-done');
      return;
    }

    close();
    onUnlock && onUnlock();
  }

  return { init, open, close, allowed };
})();
