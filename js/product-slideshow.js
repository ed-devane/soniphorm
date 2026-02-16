// Product Slideshow for Active Exciter System

function initProductSlideshow() {
    const slideshow = document.querySelector('.product-slideshow');
    if (!slideshow) return; // Exit if no slideshow on page

    const slides = slideshow.querySelectorAll('.slide');
    const dotsContainer = slideshow.querySelector('.slideshow-dots');
    let currentSlide = 0;
    let autoScrollInterval;

    // Create dots
    slides.forEach((_, index) => {
        const dot = document.createElement('span');
        dot.classList.add('dot');
        if (index === 0) dot.classList.add('active');
        dot.addEventListener('click', () => goToSlide(index));
        dotsContainer.appendChild(dot);
    });

    const dots = dotsContainer.querySelectorAll('.dot');

    // Show specific slide
    function goToSlide(n) {
        // Remove active class from current slide and dot
        slides[currentSlide].classList.remove('active');
        dots[currentSlide].classList.remove('active');

        // Update current slide index
        currentSlide = n;
        if (currentSlide >= slides.length) currentSlide = 0;
        if (currentSlide < 0) currentSlide = slides.length - 1;

        // Add active class to new slide and dot
        slides[currentSlide].classList.add('active');
        dots[currentSlide].classList.add('active');

        // Reset auto-scroll timer
        resetAutoScroll();
    }

    // Next slide
    function nextSlide() {
        goToSlide(currentSlide + 1);
    }

    // Start auto-scrolling
    function startAutoScroll() {
        autoScrollInterval = setInterval(nextSlide, 4000); // Change slide every 4 seconds
    }

    // Reset auto-scroll
    function resetAutoScroll() {
        clearInterval(autoScrollInterval);
        startAutoScroll();
    }

    // Pause on hover
    slideshow.addEventListener('mouseenter', () => {
        clearInterval(autoScrollInterval);
    });

    // Resume on mouse leave
    slideshow.addEventListener('mouseleave', () => {
        startAutoScroll();
    });

    // Start auto-scrolling
    startAutoScroll();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProductSlideshow);
} else {
    initProductSlideshow();
}
