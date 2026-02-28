/* ============================================================
   footer-component.js — Blue Chip Signals
   Injects the site footer into any page that contains:
     <div id="footer-placeholder"
          data-footer-type="standard-social|back-to-home|minimal"
          data-base=""></div>

   data-footer-type:
     standard-social (default) — copyright + Terms & Legal + social icons
     back-to-home              — same as standard-social + Back to Home link
     minimal                   — copyright + Terms & Legal, no social icons
   data-base:
     '' for root-level pages, '../../' for pages two levels deep
   ============================================================ */
(function () {
    var placeholder = document.getElementById('footer-placeholder');
    if (!placeholder) return;

    var type = placeholder.getAttribute('data-footer-type') || 'standard-social';
    var base = placeholder.getAttribute('data-base') || '';

    var footer = document.createElement('footer');
    footer.innerHTML = buildFooter(type, base);
    placeholder.parentNode.replaceChild(footer, placeholder);

    function buildFooter(type, base) {
        var termsLink = '<a href="' + base + 'terms.html">Terms &amp; Legal</a>';
        var homeLink  = '<a href="' + base + 'index.html">Back to Home</a>';

        var social = '<div class="social-media">' +
            '<a href="https://www.tiktok.com/@bluechip.signals" target="_blank" aria-label="TikTok">' +
                '<i class="fab fa-tiktok"></i>' +
            '</a>' +
            '<a href="https://www.instagram.com/bluechip.signals/" target="_blank" aria-label="Instagram">' +
                '<i class="fab fa-instagram"></i>' +
            '</a>' +
        '</div>';

        var copyright = '&copy; 2025 Blue Chip Signals. All rights reserved.';

        switch (type) {
            case 'back-to-home':
                return '<p>' + copyright + ' | ' + termsLink + ' | ' + homeLink + '</p>' + social;

            case 'minimal':
                return '<p>' + copyright + ' | ' + termsLink + '</p>';

            default: /* standard-social */
                return '<p>' + copyright + ' | ' + termsLink + '</p>' + social;
        }
    }
})();
