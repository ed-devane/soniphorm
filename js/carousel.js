// Auto-rotating carousel for featured products
(function() {
    const carousel = document.querySelector('.carousel-track');
    const slides = document.querySelectorAll('.carousel-slide');
    const dots = document.querySelectorAll('.dot');
    const prevBtn = document.querySelector('.carousel-btn.prev');
    const nextBtn = document.querySelector('.carousel-btn.next');

    let currentSlide = 0;
    let autoRotateInterval;
    const AUTO_ROTATE_DELAY = 5000; // 5 seconds

    // Initialize carousel
    function init() {
        if (!carousel || slides.length === 0) return;

        showSlide(0);
        startAutoRotate();

        // Add event listeners
        if (prevBtn) prevBtn.addEventListener('click', () => {
            stopAutoRotate();
            previousSlide();
            startAutoRotate();
        });

        if (nextBtn) nextBtn.addEventListener('click', () => {
            stopAutoRotate();
            nextSlide();
            startAutoRotate();
        });

        // Dot navigation
        dots.forEach((dot, index) => {
            dot.addEventListener('click', () => {
                stopAutoRotate();
                showSlide(index);
                startAutoRotate();
            });
        });

        // Pause auto-rotate on hover
        carousel.addEventListener('mouseenter', stopAutoRotate);
        carousel.addEventListener('mouseleave', startAutoRotate);
    }

    // Show specific slide
    function showSlide(index) {
        // Remove active class from all slides and dots
        slides.forEach(slide => slide.classList.remove('active'));
        dots.forEach(dot => dot.classList.remove('active'));

        // Add active class to current slide and dot
        if (slides[index]) {
            slides[index].classList.add('active');
        }
        if (dots[index]) {
            dots[index].classList.add('active');
        }

        currentSlide = index;
    }

    // Go to next slide
    function nextSlide() {
        const nextIndex = (currentSlide + 1) % slides.length;
        showSlide(nextIndex);
    }

    // Go to previous slide
    function previousSlide() {
        const prevIndex = (currentSlide - 1 + slides.length) % slides.length;
        showSlide(prevIndex);
    }

    // Start auto-rotation
    function startAutoRotate() {
        autoRotateInterval = setInterval(nextSlide, AUTO_ROTATE_DELAY);
    }

    // Stop auto-rotation
    function stopAutoRotate() {
        if (autoRotateInterval) {
            clearInterval(autoRotateInterval);
        }
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            stopAutoRotate();
            previousSlide();
            startAutoRotate();
        } else if (e.key === 'ArrowRight') {
            stopAutoRotate();
            nextSlide();
            startAutoRotate();
        }
    });

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
