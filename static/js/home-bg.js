/* home-bg.js — 흐르는 빛 리본 + 꽃잎/반짝이 애니메이션 */
(function () {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h;
  const t0 = performance.now();

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── bezier 점 보간 ──────────────────────────────────── */
  function bpt(p0, p1, p2, p3, u) {
    const v = 1 - u;
    return v*v*v*p0 + 3*v*v*u*p1 + 3*v*u*u*p2 + u*u*u*p3;
  }

  /* ── 리본 설정 (상단/하단 2개, 은하수 액자) ─────────── */
  const RIBBONS = [
    { yA: 0.09, yB: 0.12, sp: 0.16, ph: 0.0,  a: 0.13, w: 9, amp: 0.07 },
    { yA: 0.82, yB: 0.84, sp: 0.14, ph: 3.14, a: 0.12, w: 8, amp: 0.07 },
  ];

  function ribbon(r, t) {
    const p   = r.ph + t * r.sp;
    const amp = r.amp;
    const sy  = h * (r.yA + amp * Math.sin(p));
    const ey  = h * (r.yB + amp * Math.cos(p * 0.75));
    const cx1 = w * 0.27 + w * 0.09 * Math.sin(p * 1.3);
    const cy1 = h * (r.yA + amp * 0.6 * Math.cos(p * 1.5));
    const cx2 = w * 0.73 + w * 0.09 * Math.cos(p * 0.9);
    const cy2 = h * (r.yB + amp * 0.6 * Math.sin(p * 1.2));

    function path() {
      ctx.beginPath();
      ctx.moveTo(-40, sy);
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, w + 40, ey);
    }

    ctx.save();
    ctx.lineCap = 'round';

    /* 성운 구름 (넓고 흐린 보랏빛 배경) */
    path();
    ctx.strokeStyle = `rgba(70, 55, 165, ${r.a * 0.08})`;
    ctx.lineWidth = r.w * 26;
    ctx.shadowBlur = 0;
    ctx.stroke();
    path();
    ctx.strokeStyle = `rgba(55, 90, 185, ${r.a * 0.10})`;
    ctx.lineWidth = r.w * 17;
    ctx.stroke();

    /* 외곽 넓은 광채 */
    path();
    ctx.strokeStyle = `rgba(40, 90, 200, ${r.a * 0.13})`;
    ctx.lineWidth = r.w * 11;
    ctx.shadowBlur = 0;
    ctx.stroke();

    /* 중간 글로우 */
    path();
    ctx.strokeStyle = `rgba(70, 140, 255, ${r.a * 0.32})`;
    ctx.lineWidth = r.w * 4.5;
    ctx.stroke();

    /* 코어 라인 */
    path();
    ctx.strokeStyle = `rgba(140, 200, 255, ${r.a * 1.15})`;
    ctx.lineWidth = r.w;
    ctx.stroke();

    /* 하이라이트 */
    path();
    ctx.strokeStyle = `rgba(220, 248, 255, ${Math.min(r.a * 3.2, 0.82)})`;
    ctx.lineWidth = Math.max(r.w * 0.20, 1.2);
    ctx.stroke();

    /* 반짝 시머 (시간에 따라 깜박) */
    const flicker = 0.5 + 0.5 * Math.sin(t * 4.1 + r.ph * 5.3);
    path();
    ctx.strokeStyle = `rgba(200, 238, 255, ${r.a * flicker * 0.45})`;
    ctx.lineWidth = r.w * 0.45;
    ctx.stroke();

    /* ── 은하수 별먼지: 리본 경로 위아래로 흩뿌려진 별 ── */
    const spread = r.w * 5.5;
    for (let i = 0; i < 55; i++) {
      const u  = i / 55;
      const bx = bpt(-40, cx1, cx2, w + 40, u);
      const by = bpt(sy, cy1, cy2, ey, u);
      const oy = Math.sin(i * 127.3 + r.ph * 50) * spread;
      const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * (1.2 + i * 0.35) + i * 2.1));
      const gauss   = Math.exp(-(oy * oy) / (spread * spread * 0.6));
      const dotA    = r.a * 1.6 * twinkle * gauss;
      const dotR    = 0.4 + Math.abs(Math.sin(i * 83.7)) * 1.1;
      if (dotA < 0.03) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(bx, by + oy, dotR, 0, Math.PI * 2);
      ctx.fillStyle   = `rgba(230, 246, 255, ${dotA})`;
      ctx.shadowBlur  = dotR * 3.5;
      ctx.shadowColor = `rgba(170, 220, 255, ${dotA * 0.55})`;
      ctx.fill();
      ctx.restore();
    }

    /* 이동하는 반짝이 점들 */
    const numDots = 7;
    for (let i = 0; i < numDots; i++) {
      const prog = ((t * 0.02 + i / numDots + r.ph * 0.04) % 1.0);
      const bx = bpt(-40, cx1, cx2, w + 40, prog);
      const by = bpt(sy, cy1, cy2, ey, prog);
      const dotA = r.a * 2.8 * Math.sin(prog * Math.PI);
      if (dotA < 0.01) continue;

      ctx.save();
      /* 점 글로우 */
      ctx.beginPath();
      ctx.arc(bx, by, r.w * 1.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(160, 220, 255, ${dotA * 0.30})`;
      ctx.shadowBlur = r.w * 5;
      ctx.shadowColor = `rgba(130, 200, 255, ${dotA * 0.6})`;
      ctx.fill();
      /* 점 코어 */
      ctx.beginPath();
      ctx.arc(bx, by, r.w * 0.60, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(230, 250, 255, ${dotA})`;
      ctx.shadowBlur = r.w * 2.5;
      ctx.shadowColor = `rgba(180, 230, 255, ${dotA})`;
      ctx.fill();
      /* 작은 십자 빛살 */
      if (dotA > 0.22) {
        const ds = r.w * 1.2;
        ctx.beginPath();
        ctx.moveTo(bx - ds, by); ctx.lineTo(bx + ds, by);
        ctx.moveTo(bx, by - ds); ctx.lineTo(bx, by + ds);
        ctx.strokeStyle = `rgba(255, 255, 255, ${dotA * 0.75})`;
        ctx.lineWidth = 1.0;
        ctx.shadowBlur = ds * 2;
        ctx.shadowColor = `rgba(200, 240, 255, ${dotA * 0.55})`;
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  /* ── 꽃잎 그리기 ──────────────────────────────────────── */
  function drawPetal(p, fade) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    const r = p.r;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.6);
    ctx.bezierCurveTo( r * 1.4, -r * 0.8,  r * 1.4,  r * 0.8, 0,  r * 1.6);
    ctx.bezierCurveTo(-r * 1.4,  r * 0.8, -r * 1.4, -r * 0.8, 0, -r * 1.6);
    ctx.fillStyle   = `rgba(225, 238, 255, ${fade * 0.82})`;
    ctx.shadowBlur  = r * 5;
    ctx.shadowColor = `rgba(160, 210, 255, ${fade * 0.40})`;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.3);
    ctx.lineTo(0,  r * 1.3);
    ctx.strokeStyle = `rgba(245, 252, 255, ${fade * 0.35})`;
    ctx.lineWidth   = r * 0.14;
    ctx.shadowBlur  = 0;
    ctx.stroke();
    ctx.restore();
  }

  /* ── 파티클 팩토리 ────────────────────────────────────── */
  function mkP(settled) {
    const ml      = 320 + Math.random() * 520;
    const isPetal = Math.random() < 0.65;
    return {
      x:    Math.random() * w,
      y:    settled ? Math.random() * h : h + 10,
      vx:   (Math.random() - 0.5) * 0.28,
      vy:   -(0.06 + Math.random() * 0.28),
      r:    isPetal ? 1.5 + Math.random() * 2.0 : 0.5 + Math.random() * 1.2,
      a:    0.22 + Math.random() * 0.50,
      life: settled ? Math.floor(Math.random() * ml) : 0,
      ml,
      petal: isPetal,
      rot:   Math.random() * Math.PI * 2,
      rotV:  (Math.random() - 0.5) * 0.006,
    };
  }

  const PS = Array.from({ length: 88 }, () => mkP(true));

  /* ── 배경 별 필드 (고정 위치, 각자 깜박) ─────────────── */
  const BG_STARS = Array.from({ length: 130 }, () => ({
    fx: Math.random(), fy: Math.random(),
    r:  0.3 + Math.random() * 0.9,
    a:  0.12 + Math.random() * 0.40,
    ph: Math.random() * Math.PI * 2,
    sp: 0.3 + Math.random() * 2.0,
  }));

  function drawBgStars(t) {
    for (const s of BG_STARS) {
      const alpha = s.a * (0.5 + 0.5 * Math.sin(t * s.sp + s.ph));
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.fx * w, s.fy * h, s.r, 0, Math.PI * 2);
      ctx.fillStyle   = `rgba(215, 238, 255, ${alpha})`;
      ctx.shadowBlur  = s.r * 3;
      ctx.shadowColor = `rgba(175, 215, 255, ${alpha * 0.5})`;
      ctx.fill();
      ctx.restore();
    }
  }

  /* ── 고정 반짝이 위치 ─────────────────────────────────── */
  /* SPARKLES_A[0] { fx:0.08, fy:0.14 } 삭제됨 */
  const SPARKLES_A = [
    { fx: 0.22, fy: 0.38, s: 3.0, a: 0.68 },
    { fx: 0.35, fy: 0.72, s: 3.4, a: 0.74 },
    { fx: 0.50, fy: 0.22, s: 5.5, a: 0.92 },
    { fx: 0.63, fy: 0.58, s: 3.2, a: 0.70 },
    { fx: 0.76, fy: 0.85, s: 2.8, a: 0.58 },
    { fx: 0.88, fy: 0.33, s: 4.5, a: 0.86 },
    { fx: 0.15, fy: 0.88, s: 2.8, a: 0.55 },
    { fx: 0.72, fy: 0.16, s: 3.4, a: 0.76 },
    { fx: 0.93, fy: 0.70, s: 3.0, a: 0.65 },
  ];
  const SPARKLES_B = [
    { fx: 0.05, fy: 0.55, s: 4.0, a: 0.80 },
    /* { fx: 0.18, fy: 0.25 } 삭제 */
    { fx: 0.30, fy: 0.90, s: 3.6, a: 0.62 },
    { fx: 0.47, fy: 0.64, s: 3.1, a: 0.67 },
    { fx: 0.70, fy: 0.44, s: 3.0, a: 0.64 },
    { fx: 0.82, fy: 0.78, s: 3.6, a: 0.74 },
    { fx: 0.95, fy: 0.20, s: 2.8, a: 0.58 },
    { fx: 0.55, fy: 0.38, s: 3.2, a: 0.68 },
  ];

  /* ── 눈꽃/별 그리기 ────────────────────────────────────── */
  function drawSparkle(x, y, s, alpha, t) {
    const r = s * 0.22;
    ctx.save();

    /* 외곽 헤일로 */
    const halo = ctx.createRadialGradient(x, y, s * 0.4, x, y, s * 3.2);
    halo.addColorStop(0, `rgba(150, 215, 255, ${alpha * 0.20})`);
    halo.addColorStop(1, `rgba(100, 170, 255, 0)`);
    ctx.beginPath();
    ctx.arc(x, y, s * 3.2, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();

    /* 8각 별 몸체 */
    ctx.beginPath();
    ctx.moveTo(x,     y - s);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x + s, y    );
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x,     y + s);
    ctx.lineTo(x - r, y + r);
    ctx.lineTo(x - s, y    );
    ctx.lineTo(x - r, y - r);
    ctx.closePath();
    ctx.fillStyle   = `rgba(230, 248, 255, ${alpha})`;
    ctx.shadowBlur  = s * 2.2;
    ctx.shadowColor = `rgba(150, 215, 255, ${alpha * 0.70})`;
    ctx.fill();

    if (s >= 4.5) {
      /* 내부 45° 회전 별 오버레이 */
      const s2 = s * 0.68, r2 = s2 * 0.22, d = s2 * 0.707;
      ctx.beginPath();
      ctx.moveTo(x + d,  y - d );
      ctx.lineTo(x + r2, y     );
      ctx.lineTo(x + d,  y + d );
      ctx.lineTo(x,      y + r2);
      ctx.lineTo(x - d,  y + d );
      ctx.lineTo(x - r2, y     );
      ctx.lineTo(x - d,  y - d );
      ctx.lineTo(x,      y - r2);
      ctx.closePath();
      ctx.fillStyle  = `rgba(205, 240, 255, ${alpha * 0.46})`;
      ctx.shadowBlur = 0;
      ctx.fill();
    }

    /* ── 중앙 큰 눈꽃 전용: 정밀 결정체 구조 ─────────────── */
    if (s >= 6.0) {
      const rot = t * 0.07;

      ctx.save();
      ctx.translate(x, y);

      /* 바깥 6각 광채 링 */
      const ringGrad = ctx.createRadialGradient(0, 0, s * 1.6, 0, 0, s * 2.8);
      ringGrad.addColorStop(0, `rgba(160, 225, 255, ${alpha * 0.18})`);
      ringGrad.addColorStop(1, `rgba(120, 190, 255, 0)`);
      ctx.beginPath();
      ctx.arc(0, 0, s * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = ringGrad;
      ctx.fill();

      /* 6개 주 팔 결정체 */
      ctx.lineCap = 'round';
      for (let arm = 0; arm < 6; arm++) {
        ctx.save();
        ctx.rotate(rot + arm * Math.PI / 3);

        const armLen = s * 2.1;

        /* 주 팔 라인 */
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -armLen);
        ctx.strokeStyle = `rgba(215, 248, 255, ${alpha * 0.96})`;
        ctx.lineWidth = s * 0.15;
        ctx.shadowBlur = s * 1.4;
        ctx.shadowColor = `rgba(140, 210, 255, ${alpha * 0.85})`;
        ctx.stroke();

        /* 1단계 가지 (팔의 62%) */
        const b1y   = -armLen * 0.62;
        const b1len = armLen * 0.42;
        ctx.beginPath();
        ctx.moveTo(0, b1y);
        ctx.lineTo( b1len * 0.707, b1y - b1len * 0.707);
        ctx.moveTo(0, b1y);
        ctx.lineTo(-b1len * 0.707, b1y - b1len * 0.707);
        ctx.lineWidth = s * 0.10;
        ctx.shadowBlur = s * 0.9;
        ctx.stroke();

        /* 2단계 가지 (팔의 38%) */
        const b2y   = -armLen * 0.38;
        const b2len = armLen * 0.28;
        ctx.beginPath();
        ctx.moveTo(0, b2y);
        ctx.lineTo( b2len * 0.707, b2y - b2len * 0.707);
        ctx.moveTo(0, b2y);
        ctx.lineTo(-b2len * 0.707, b2y - b2len * 0.707);
        ctx.lineWidth = s * 0.07;
        ctx.shadowBlur = s * 0.6;
        ctx.stroke();

        /* 3단계 미세 가지 (팔의 20%) */
        const b3y   = -armLen * 0.20;
        const b3len = armLen * 0.15;
        ctx.beginPath();
        ctx.moveTo(0, b3y);
        ctx.lineTo( b3len * 0.707, b3y - b3len * 0.707);
        ctx.moveTo(0, b3y);
        ctx.lineTo(-b3len * 0.707, b3y - b3len * 0.707);
        ctx.lineWidth = s * 0.05;
        ctx.shadowBlur = s * 0.4;
        ctx.stroke();

        /* 끝 결정 점 */
        ctx.beginPath();
        ctx.arc(0, -armLen, s * 0.13, 0, Math.PI * 2);
        ctx.fillStyle  = `rgba(245, 254, 255, ${alpha})`;
        ctx.shadowBlur = s * 1.0;
        ctx.shadowColor = `rgba(190, 235, 255, ${alpha})`;
        ctx.fill();

        ctx.restore();
      }


      /* 6각 꼭짓점 빛 점 (천천히 회전) */
      ctx.save();
      ctx.rotate(rot * 0.5 + Math.PI / 6);
      for (let i = 0; i < 6; i++) {
        ctx.save();
        ctx.rotate(i * Math.PI / 3);
        ctx.beginPath();
        ctx.arc(0, -s * 2.3, s * 0.14, 0, Math.PI * 2);
        ctx.fillStyle  = `rgba(235, 252, 255, ${alpha * 0.90})`;
        ctx.shadowBlur = s * 1.2;
        ctx.shadowColor = `rgba(170, 225, 255, ${alpha * 0.80})`;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      /* 12각 외곽 미세 점 링 */
      ctx.save();
      ctx.rotate(-rot * 0.3);
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate(i * Math.PI / 6);
        ctx.beginPath();
        ctx.arc(0, -s * 1.65, s * 0.07, 0, Math.PI * 2);
        ctx.fillStyle  = `rgba(210, 245, 255, ${alpha * 0.55})`;
        ctx.shadowBlur = s * 0.5;
        ctx.shadowColor = `rgba(160, 215, 255, ${alpha * 0.4})`;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      /* 중심 보석 */
      const gemGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.44);
      gemGrad.addColorStop(0,   `rgba(255, 255, 255, ${alpha})`);
      gemGrad.addColorStop(0.45, `rgba(220, 248, 255, ${alpha * 0.88})`);
      gemGrad.addColorStop(1,    `rgba(150, 210, 255, ${alpha * 0.28})`);
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.44, 0, Math.PI * 2);
      ctx.fillStyle  = gemGrad;
      ctx.shadowBlur = s * 2.0;
      ctx.shadowColor = `rgba(190, 235, 255, ${alpha * 0.95})`;
      ctx.fill();

      /* 중심 십자 빛살 */
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate(rot * 2 + i * Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -s * 0.80);
        ctx.strokeStyle = `rgba(240, 252, 255, ${alpha * 0.55})`;
        ctx.lineWidth   = s * 0.06;
        ctx.shadowBlur  = s * 0.6;
        ctx.shadowColor = `rgba(190, 235, 255, ${alpha * 0.5})`;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    }

    ctx.restore();
  }

  /* ── 메인 루프 ────────────────────────────────────────── */
  function tick() {
    const t = (performance.now() - t0) / 1000;
    ctx.clearRect(0, 0, w, h);

    drawBgStars(t);

    const pulseA = 0.55 + 0.45 * 0.5 * (1 - Math.cos(2 * Math.PI * t / 5.8));
    const pulseB = 0.45 + 0.45 * 0.5 * (1 - Math.cos(2 * Math.PI * (t - 2.5) / 7.2));
    SPARKLES_A.forEach(sp => drawSparkle(sp.fx * w, sp.fy * h, sp.s, sp.a * pulseA, t));
    SPARKLES_B.forEach(sp => drawSparkle(sp.fx * w, sp.fy * h, sp.s, sp.a * pulseB, t));

    for (let i = 0; i < PS.length; i++) {
      const p = PS[i];
      p.x   += p.vx;
      p.y   += p.vy;
      p.life++;
      if (p.petal) p.rot += p.rotV;

      if (p.life > p.ml || p.y < -16) { PS[i] = mkP(false); continue; }

      const tl   = p.life / p.ml;
      const fade = p.a * (tl < 0.14 ? tl / 0.14 : tl > 0.78 ? (1 - tl) / 0.22 : 1);

      if (p.petal) {
        drawPetal(p, fade);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(225, 245, 255, ${fade})`;
        ctx.shadowBlur  = 10;
        ctx.shadowColor = `rgba(140, 210, 255, ${fade * 0.65})`;
        ctx.fill();
        ctx.restore();
      }
    }

    requestAnimationFrame(tick);
  }

  tick();
})();
